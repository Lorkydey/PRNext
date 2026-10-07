import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './cargo.mjs';
import { packageManifest, platforms, nativePlatform } from '../packages/prnext/native/resolve.mjs';

export const metadataProofName = 'metadata-refresh.json';
export const metadataBaseName = '.metadata-base';
export const metadataFields = ['homepage', 'repository', 'bugs', 'author', 'keywords'];
export const archiveFilename = (name = packageManifest.name, version = packageManifest.version) => `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
export const archiveNames = () => [packageManifest.name, ...platforms.map(target => target.package)].map(name => archiveFilename(name));
export const reportNames = () => platforms.flatMap(target => ['', '-nested'].map(suffix => `verified-${target.id}${suffix}.json`));
export const archiveDigest = bytes => ({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') });

export function expectedMetadata(main, source = packageManifest) {
  const result = Object.fromEntries([...metadataFields, ...(main ? ['description'] : [])].filter(key => Object.hasOwn(source, key)).map(key => [key, structuredClone(source[key])]));
  if (!main && result.repository && typeof result.repository === 'object') delete result.repository.directory;
  return result;
}

// npm's PRNext archives use regular USTAR entries. Fail closed on links, PAX,
// duplicate names, or unexpected formats instead of extracting untrusted paths.
export function readArchive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 ** 2 });
  const entries = new Map();
  const string = data => data.toString('utf8').replace(/\0.*$/s, '');
  const octal = data => {
    const value = string(data).trim();
    assert.match(value, /^[0-7]+$/, 'Unsupported tar numeric field');
    return parseInt(value, 8);
  };
  let offset = 0, terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      assert.ok(tar.subarray(offset).every(byte => byte === 0), 'Unexpected data after tar terminator');
      terminated = true;
      break;
    }
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    assert.equal(octal(header.subarray(148, 156)), checksum, 'Invalid tar header checksum');
    assert.equal(string(header.subarray(257, 263)), 'ustar', 'Unsupported tar archive format');
    const prefix = string(header.subarray(345, 500));
    const name = `${prefix ? prefix + '/' : ''}${string(header.subarray(0, 100))}`;
    const type = string(header.subarray(156, 157)) || '0';
    assert.equal(type, '0', `Unsupported tar entry type for ${name}`);
    assert.ok(name.startsWith('package/') && !name.includes('\\') && name.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe archive path: ${name}`);
    assert.ok(!entries.has(name), `Duplicate archive entry: ${name}`);
    const size = octal(header.subarray(124, 136));
    const mode = octal(header.subarray(100, 108));
    assert.ok(Number.isSafeInteger(size) && size <= tar.length - offset - 512, `Truncated archive entry: ${name}`);
    entries.set(name, { mode, type, data: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(terminated && entries.has('package/package.json'), 'Incomplete npm archive');
  return entries;
}

function manifest(entries) { return JSON.parse(entries.get('package/package.json').data.toString('utf8')); }
function withoutMetadata(pkg, main) {
  const result = { ...pkg };
  for (const key of [...metadataFields, ...(main ? ['description'] : [])]) delete result[key];
  return result;
}
function assertSourceMetadata(pkg, main) {
  const fields = [...metadataFields, ...(main ? ['description'] : [])];
  assert.deepEqual(Object.fromEntries(fields.filter(key => Object.hasOwn(pkg, key)).map(key => [key, pkg[key]])), expectedMetadata(main), `${pkg.name}: archive metadata is stale; regenerate the release archives before publishing`);
}

export function compareMetadataArchives(base, current, { main, readme, metadata = expectedMetadata(main) }) {
  assert.deepEqual([...current.keys()].sort(), [...base.keys()].sort(), 'Metadata refresh changed archive entries');
  if (main) assert.ok(Buffer.isBuffer(readme) && current.get('package/README.md')?.data.equals(readme), 'Updated README differs from the current source README');
  const before = manifest(base), after = manifest(current);
  assert.deepEqual(withoutMetadata(after, main), withoutMetadata(before, main), 'Metadata refresh changed functional package.json fields');
  const fields = [...metadataFields, ...(main ? ['description'] : [])];
  assert.deepEqual(Object.fromEntries(fields.filter(key => Object.hasOwn(after, key)).map(key => [key, after[key]])), metadata, 'Metadata refresh does not match source metadata');
  const changed = [];
  for (const [name, oldEntry] of base) {
    const entry = current.get(name);
    assert.equal(entry.mode, oldEntry.mode, `${name}: file permissions changed`);
    assert.equal(entry.type, oldEntry.type, `${name}: file type changed`);
    if (entry.data.equals(oldEntry.data)) continue;
    changed.push(name);
    if (name === 'package/package.json') continue;
    if (main && name === 'package/README.md') {
      assert.ok(Buffer.isBuffer(readme) && entry.data.equals(readme), 'Updated README differs from the current source README');
      continue;
    }
    throw new Error(`${name}: runtime or native bytes changed; run the full package verification matrix`);
  }
  return changed;
}

// These reports are evidence about their original bytes only. Never rewrite
// their hashes when preparing a metadata-only derivative.
export async function verifyExactArtifacts({ directory = path.join(repositoryRoot, 'artifacts/npm'), hostOnly = false, checkMetadata = true } = {}) {
  const selected = hostOnly ? [nativePlatform()] : platforms;
  const digests = new Map(), nativeIntegrity = new Map();
  async function digest(filename) {
    if (filename !== path.basename(filename) || !filename.endsWith('.tgz')) throw new Error(`Invalid archive name in report: ${filename}`);
    if (!digests.has(filename)) {
      const bytes = await readFile(path.join(directory, filename));
      if (checkMetadata) assertSourceMetadata(manifest(readArchive(bytes)), filename === archiveFilename(packageManifest.name));
      digests.set(filename, archiveDigest(bytes));
    }
    return digests.get(filename);
  }
  for (const target of selected) {
    for (const strategy of ['hoisted', 'nested']) {
      const filename = `verified-${target.id}${strategy === 'nested' ? '-nested' : ''}.json`;
      let report;
      try { report = JSON.parse(await readFile(path.join(directory, filename), 'utf8')); }
      catch (cause) { throw new Error(`Missing verification report ${filename}. Run the package tests on this platform, or collect the successful CI artifacts in ${directory}.`, { cause }); }
      assert.equal(report.version, packageManifest.version, `${filename}: obsolete version`);
      assert.equal(report.platform, target.id, `${filename}: wrong platform`);
      assert.equal(report.strategy, strategy, `${filename}: wrong install strategy`);
      assert.equal(report.checks?.length, 10, `${filename}: incomplete package checks`);
      const names = [archiveFilename(packageManifest.name), archiveFilename(target.package)];
      assert.deepEqual(report.archives.map(item => item.filename).sort(), names.sort(), `${filename}: wrong archives`);
      for (const archive of report.archives) {
        const actual = await digest(archive.filename);
        assert.equal(report.sha256[archive.filename], actual.sha256, `${archive.filename} changed since ${filename}; rerun verification`);
        assert.equal(archive.integrity, actual.integrity, `${archive.filename}: integrity mismatch`);
        assert.equal(archive.size, actual.size, `${archive.filename}: size mismatch`);
        if (archive.filename.startsWith(target.package + '-')) nativeIntegrity.set(target.package, actual.integrity);
      }
    }
  }
  return nativeIntegrity;
}

export async function verifyArtifacts({ directory = path.join(repositoryRoot, 'artifacts/npm'), hostOnly = false } = {}) {
  let proof;
  try { proof = JSON.parse(await readFile(path.join(directory, metadataProofName), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return verifyExactArtifacts({ directory, hostOnly }); throw error; }
  assert.equal(proof.kind, 'prnext-metadata-only-v1', 'Unsupported metadata refresh proof');
  assert.equal(proof.version, packageManifest.version, 'Metadata proof version is stale');
  assert.equal(proof.baseDirectory, metadataBaseName, 'Invalid metadata base directory');
  assert.deepEqual(proof.archives.map(item => item.filename).sort(), archiveNames().sort(), 'Metadata proof archive set is incomplete');
  const baseDirectory = path.join(directory, metadataBaseName);
  await verifyExactArtifacts({ directory: baseDirectory, hostOnly, checkMetadata: false });
  const selected = hostOnly ? [nativePlatform()] : platforms;
  const names = new Set([archiveFilename(packageManifest.name), ...selected.map(target => archiveFilename(target.package))]);
  for (const target of selected) for (const suffix of ['', '-nested']) {
    const name = `verified-${target.id}${suffix}.json`;
    assert.ok((await readFile(path.join(directory, name))).equals(await readFile(path.join(baseDirectory, name))), `${name}: original test evidence was modified`);
  }
  const readme = await readFile(path.join(repositoryRoot, 'packages/prnext/README.md'));
  const nativeIntegrity = new Map();
  for (const record of proof.archives) {
    if (!names.has(record.filename)) continue;
    const base = await readFile(path.join(baseDirectory, record.filename));
    const current = await readFile(path.join(directory, record.filename));
    assert.deepEqual(record.original, archiveDigest(base), `${record.filename}: original archive digest mismatch`);
    assert.deepEqual(record.current, archiveDigest(current), `${record.filename}: refreshed archive digest mismatch`);
    const main = record.filename === archiveFilename(packageManifest.name);
    const changed = compareMetadataArchives(readArchive(base), readArchive(current), { main, readme });
    assert.deepEqual(record.changedEntries, changed, `${record.filename}: changed entry evidence mismatch`);
    if (!main) nativeIntegrity.set(manifest(readArchive(current)).name, record.current.integrity);
  }
  nativeIntegrity.metadataOnly = true;
  return nativeIntegrity;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--host') options.hostOnly = true;
      else if (args[i] === '--directory' && args[i + 1] && !args[i + 1].startsWith('--')) options.directory = path.resolve(args[++i]);
      else throw new Error('Usage: node scripts/verify-npm-artifacts.mjs [--host] [--directory path]');
    }
    const result = await verifyArtifacts(options);
    console.log(result.metadataOnly
      ? `Verified metadata-only derivatives for ${result.size} native platform(s): original exact-byte test reports preserved; runtime/native contents and permissions unchanged. The platform installation tests were not rerun on these tarball bytes.`
      : `Verified exact archive bytes and both installation strategies for ${result.size} native platform(s).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
