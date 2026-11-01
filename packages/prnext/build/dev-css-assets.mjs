import { copyFile, link, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { rename } from '../runtime/fs.mjs';

export const STYLE_OVERLAY_LIMITS = Object.freeze({ files: 4096, bytes: 64 * 1024 * 1024, catalogueBytes: 4 * 1024 * 1024, references: 16384 });
const digest = data => createHash('sha256').update(data).digest('hex');
const filename = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..'
  && !/[\\/\x00-\x1f<>:"|?*#]/.test(name) && path.basename(name) === name;
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };

export class StyleOverlayFallback extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fallback = code => { throw new StyleOverlayFallback(code); };

function assetsFor(bundles) {
  const assets = new Map();
  let references = 0, bytes = 0;
  for (const files of bundles.values()) for (const file of files) {
    if (++references > STYLE_OVERLAY_LIMITS.references) fallback('style-overlay-budget');
    if (!file || !filename(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > STYLE_OVERLAY_LIMITS.bytes || !/^[a-f0-9]{64}$/.test(file.sha256)) fallback('invalid-style-overlay');
    const previous = assets.get(file.name);
    if (previous && (previous.bytes !== file.bytes || previous.sha256 !== file.sha256)) fallback('conflicting-style-overlay');
    if (!previous) {
      assets.set(file.name, file);
      bytes += file.bytes;
      if (assets.size > STYLE_OVERLAY_LIMITS.files || bytes > STYLE_OVERLAY_LIMITS.bytes) fallback('style-overlay-budget');
    }
  }
  return assets;
}

function catalogue(previous, plans) {
  const bundles = new Map();
  if (!previous) return bundles;
  if (previous.version !== 1 || typeof previous.baseDirectory !== 'string' || previous.baseDirectory.length > 4096
    || !Array.isArray(previous.bundles) || previous.bundles.length > STYLE_OVERLAY_LIMITS.files) fallback('invalid-style-overlay');
  let references = 0;
  for (const entry of previous.bundles) {
    if (!Array.isArray(entry) || entry.length !== 2 || !plans.has(entry[0]) || bundles.has(entry[0]) || !Array.isArray(entry[1]) || entry[1].length > STYLE_OVERLAY_LIMITS.files) fallback('invalid-style-overlay');
    references += entry[1].length;
    if (references > STYLE_OVERLAY_LIMITS.references) fallback('style-overlay-budget');
    if (!entry[1].some(file => file?.name === entry[0])) fallback('invalid-style-overlay');
    bundles.set(entry[0], entry[1]);
  }
  assetsFor(bundles);
  if (Buffer.byteLength(JSON.stringify(previous)) > STYLE_OVERLAY_LIMITS.catalogueBytes) fallback('style-overlay-budget');
  return bundles;
}

async function inspect(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > STYLE_OVERLAY_LIMITS.bytes) fallback('invalid-style-overlay');
  const data = await readFile(file);
  return { name: path.basename(file), bytes: data.byteLength, sha256: digest(data) };
}

/** A CSS generation owns only explicitly catalogued stylesheet assets. */
export async function createStyleOverlay({ root, source, destination, baseSource = source, manifest, plans, selected }) {
  const previous = manifest.devStyles.overlay;
  if (!previous && manifest.devStyles.baseClient) fallback('missing-style-overlay');
  if (previous && !manifest.devStyles.baseClient) fallback('invalid-style-overlay');
  if (!Array.isArray(plans) || plans.length > STYLE_OVERLAY_LIMITS.files) fallback('style-overlay-budget');
  const names = new Set(plans.map(([name]) => name));
  if (names.size !== plans.length || ![...names].every(filename)) fallback('invalid-style-overlay');
  const bundles = catalogue(previous, names), previousAssets = assetsFor(bundles);
  const selectedNames = new Set(selected.map(([name]) => name));
  if ([...selectedNames].some(name => !names.has(name))) fallback('invalid-style-overlay');
  for (const route of manifest.routes || []) for (const url of route.css || []) {
    if (url.includes('?v=') && !bundles.has(path.posix.basename(url.split('?')[0]))) fallback('missing-style-overlay');
  }
  const [canonicalRoot, canonicalSource, canonicalBase, parent, sourceAssets] = await Promise.all([realpath(root), realpath(source), realpath(baseSource), realpath(path.dirname(destination)), realpath(path.join(source, 'assets'))]).catch(error => {
    if (error.code === 'ENOENT') fallback('missing-style-overlay');
    throw error;
  });
  // The destination does not exist yet. Its existing parent supplies the real
  // identity, including macOS /var aliases and Windows short-name prefixes.
  const canonicalDestination = path.join(parent, path.basename(destination));
  if (!inside(canonicalRoot, canonicalSource) || !inside(canonicalRoot, canonicalBase)
    || parent !== canonicalRoot && !inside(canonicalRoot, parent) || !inside(canonicalRoot, canonicalDestination)
    || canonicalDestination === canonicalSource || canonicalDestination === canonicalBase
    || inside(canonicalDestination, canonicalSource) || inside(canonicalSource, canonicalDestination)
    || inside(canonicalDestination, canonicalBase) || inside(canonicalBase, canonicalDestination)
    || sourceAssets !== path.join(canonicalSource, 'assets')) fallback('invalid-style-overlay-directory');
  const baseDirectory = path.relative(canonicalRoot, canonicalBase).replaceAll(path.sep, '/');
  if (previous ? previous.baseDirectory !== baseDirectory : canonicalSource !== canonicalBase) fallback('invalid-style-overlay-base');
  const assetsDirectory = path.join(destination, 'assets');
  let owned = false;
  async function inherit(file) {
    const from = path.join(source, 'assets', file.name), target = path.join(assetsDirectory, file.name);
    let actual;
    try { actual = await inspect(from); } catch (error) { if (error.code === 'ENOENT') fallback('missing-style-overlay-asset'); throw error; }
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) fallback('invalid-style-overlay-asset');
    try { await link(from, target); }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) throw error;
      await copyFile(from, target);
    }
  }
  try {
    await mkdir(destination);
    owned = true;
    await mkdir(assetsDirectory);
    for (const name of selected.map(([name]) => name)) bundles.delete(name);
    for (const file of assetsFor(bundles).values()) await inherit(file);
  } catch (error) {
    if (owned) await rm(destination, { recursive: true, force: true });
    throw error;
  }

  return {
    async recordBundle(name, result) {
      if (!selectedNames.has(name)) fallback('invalid-style-overlay-output');
      const files = new Map();
      for (const output of result.outputFiles) {
        if (path.dirname(path.resolve(output.path)) !== path.resolve(assetsDirectory) || !filename(path.basename(output.path))) fallback('invalid-style-overlay-output');
        const file = { name: path.basename(output.path), bytes: output.contents.byteLength, sha256: digest(output.contents) };
        files.set(file.name, file);
      }
      if (!files.has(name)) fallback('invalid-style-overlay-output');
      // CSS Module compilation emits its URL assets before the outer CSS
      // bundle. Its absolute, external URL-token imports identify exactly the
      // emitted images/fonts to retain, without scanning the JavaScript build.
      const prefix = manifest.config.assetBase.replace(/\/$/, '') + '/';
      for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports || []) {
        if (item.kind !== 'url-token' || !item.external || !item.path.startsWith(prefix)) continue;
        let name;
        try { name = decodeURIComponent(item.path.slice(prefix.length).split(/[?#]/)[0]); }
        catch { fallback('invalid-style-overlay-output'); }
        if (!filename(name) || files.has(name)) continue;
        let file;
        try { file = await inspect(path.join(assetsDirectory, name)); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const previous = previousAssets.get(name);
          if (!previous) continue; // An unchanged base or public asset stays in its original generation.
          await inherit(previous);
          file = previous;
        }
        files.set(name, file);
      }
      bundles.set(name, [...files.values()]);
      assetsFor(bundles); // Validate the aggregate budget before publishing bytes.
      for (const output of result.outputFiles) {
        const file = files.get(path.basename(output.path));
        let existing;
        try { existing = await inspect(output.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (existing) {
          if (existing.bytes !== file.bytes || existing.sha256 !== file.sha256) fallback('conflicting-style-overlay');
          continue;
        }
        const temporary = output.path + '.' + randomUUID() + '.tmp';
        try { await writeFile(temporary, output.contents); await rename(temporary, output.path); }
        finally { await rm(temporary, { force: true }); }
      }
    },
    async finish() {
      const assets = assetsFor(bundles);
      const value = { version: 1, baseDirectory, bundles: [...bundles] };
      if (Buffer.byteLength(JSON.stringify(value)) > STYLE_OVERLAY_LIMITS.catalogueBytes) fallback('style-overlay-budget');
      // This directory was created above for CSS only. Remove module assets
      // that no current bundle references, rather than accumulating old URLs.
      const entries = await readdir(assetsDirectory, { withFileTypes: true });
      if (entries.length > STYLE_OVERLAY_LIMITS.references) fallback('style-overlay-budget');
      for (const entry of entries) {
        if (!entry.isFile() || !filename(entry.name)) fallback('invalid-style-overlay-output');
        if (!assets.has(entry.name)) await rm(path.join(assetsDirectory, entry.name));
      }
      return value;
    },
  };
}
