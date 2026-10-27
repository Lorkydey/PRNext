import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const INDEX = 'deployment-assets.json';
const MAX_FILES = 1024, MAX_BYTES = 64 * 1024 * 1024, MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_AGE = 60 * 60 * 1000, MAX_GENERATIONS = 2;
// Only build-owned, immutable code/styles. Never JSON, maps, HTML, public/ or server/.
const safeName = value => typeof value === 'string' && value.length < 240 && /^[a-zA-Z0-9_.-]+-[a-zA-Z0-9]{8,64}\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|avif|webp|gif|svg|ico|wasm)$/.test(value);
const assetKey = name => process.platform === 'win32' ? name.toLowerCase() : name;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function regular(file, limit) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) return;
  return info;
}
async function indexAt(directory) {
  try {
    if (!await regular(path.join(directory, INDEX), 1024 * 1024)) return;
    const value = JSON.parse(await readFile(path.join(directory, INDEX), 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.generations) || value.generations.length > 6) return;
    for (const generation of value.generations) {
      if (typeof generation.id !== 'string' || generation.id.length > 128 || !Number.isSafeInteger(generation.createdAt) || !Array.isArray(generation.files) || generation.files.length > MAX_FILES) return;
      const seen = new Set();
      for (const file of generation.files) {
        if (!safeName(file.name) || seen.has(assetKey(file.name)) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.hash)) return;
        seen.add(assetKey(file.name));
      }
    }
    return value;
  } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) { /* Corrupt previous metadata is an optional retention miss. */ } }
}

/** Copy only public immutable assets into a stage, before its atomic publication. */
export async function retainDeploymentAssets({ stage, destination, manifest, policy, now = Date.now() }) {
  if (manifest.dev) return { generations: 0, files: 0, bytes: 0 };
  const maxAge = (policy && policy.maxAge !== undefined ? policy.maxAge * 1000 : MAX_AGE);
  const maxGenerations = policy && policy.maxGenerations !== undefined ? policy.maxGenerations : MAX_GENERATIONS;
  const maxBytes = policy && policy.maxBytes !== undefined ? policy.maxBytes : MAX_BYTES;
  const assets = path.join(stage, 'assets');
  const assetInfo = await lstat(assets);
  if (!assetInfo.isDirectory() || assetInfo.isSymbolicLink()) throw new Error('Deployment assets must be a regular directory');
  const current = { id: manifest.cacheId, createdAt: now, eligible: true, files: [] };
  let indexedBytes = 0;
  for (const name of (await readdir(assets)).sort()) {
    if (!safeName(name)) {
      // Maps/manifests do not participate in executable chunk graphs. Unknown
      // content-addressed media and auxiliary directories make retention unsafe.
      if (/\.(?:map|json|html|txt|gz|br)$/.test(name)) continue;
      current.eligible = false; current.files = []; break;
    }
    const file = path.join(assets, name), info = await regular(file, MAX_FILE_BYTES);
    if (!info || (indexedBytes += info.size) > 256 * 1024 * 1024) { current.eligible = false; current.files = []; break; }
    const bytes = await readFile(file);
    current.files.push({ name, bytes: bytes.length, hash: hash(bytes) });
    if (current.files.length > MAX_FILES) { current.eligible = false; current.files = []; break; }
  }
  const previousRoot = await lstat(path.join(destination, 'assets')).catch(() => null);
  const previous = !current.eligible || policy === false || !previousRoot?.isDirectory() || previousRoot.isSymbolicLink() ? undefined : await indexAt(destination), generations = [current], known = new Map(current.files.map(file => [assetKey(file.name), file]));
  const retained = Object.create(null); let bytes = 0, count = 0;
  for (const generation of previous?.generations || []) {
    if (generation.eligible !== true || generations.length > maxGenerations || generation.id === current.id || generation.createdAt > now || now - generation.createdAt >= maxAge) continue;
    if (generation.files.some(file => { const value = known.get(assetKey(file.name)); return value && (value.hash !== file.hash || value.bytes !== file.bytes); })) continue;
    const candidates = generation.files.filter(file => !known.has(assetKey(file.name)));
    const size = candidates.reduce((sum, file) => sum + file.bytes, 0);
    if (bytes + size > maxBytes || count + candidates.length > MAX_FILES) continue;
    const verified = [];
    for (const file of candidates) {
      const source = path.join(destination, 'assets', file.name);
      try {
        if (!await regular(source, MAX_FILE_BYTES)) continue;
        const contents = await readFile(source);
        if (contents.length !== file.bytes || hash(contents) !== file.hash) continue;
        verified.push({file, contents});
      } catch { /* An unreadable previous asset is an optional retention miss. */ }
    }
    // An incomplete previous generation cannot promise a working chunk graph.
    if (verified.length !== candidates.length) continue;
    for (const {file, contents} of verified) {
      await writeFile(path.join(assets, file.name), contents, {flag:'wx'});
      known.set(assetKey(file.name), file); retained[file.name] = generation.createdAt + maxAge;
      bytes += file.bytes; count++;
    }
    generations.push(generation);
  }
  manifest.config.retainedAssets = retained;
  await writeFile(path.join(stage, INDEX), JSON.stringify({ version: 1, generations }) + '\n');
  return { generations: generations.length - 1, files: count, bytes };
}
