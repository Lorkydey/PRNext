import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './cargo.mjs';
import { packageManifest, platforms, nativePlatform } from '../packages/prnext/native/resolve.mjs';

// Match release evidence to the actual bytes, not just to a version string.
export async function verifyArtifacts({ directory = path.join(repositoryRoot, 'artifacts/npm'), hostOnly = false } = {}) {
  const selected = hostOnly ? [nativePlatform()] : platforms;
  const digests = new Map();
  const nativeIntegrity = new Map();
  async function digest(filename) {
    if (filename !== path.basename(filename) || !filename.endsWith('.tgz')) throw new Error(`Invalid archive name in report: ${filename}`);
    if (!digests.has(filename)) {
      const bytes = await readFile(path.join(directory, filename));
      digests.set(filename, { sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') });
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
      assert.equal(report.checks?.length, 9, `${filename}: incomplete package checks`);
      const names = [`prnext-${packageManifest.version}.tgz`, `${target.package}-${packageManifest.version}.tgz`];
      assert.deepEqual(report.archives.map(item => item.filename).sort(), names.sort(), `${filename}: wrong archives`);
      for (const archive of report.archives) {
        const actual = await digest(archive.filename);
        assert.equal(report.sha256[archive.filename], actual.sha256, `${archive.filename} changed since ${filename}; rerun verification`);
        assert.equal(archive.integrity, actual.integrity, `${archive.filename}: integrity mismatch`);
        if (archive.filename.startsWith(target.package + '-')) nativeIntegrity.set(target.package, actual.integrity);
      }
    }
  }
  return nativeIntegrity;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--host')) throw new Error('Usage: node scripts/verify-npm-artifacts.mjs [--host]');
    const result = await verifyArtifacts({ hostOnly: args.includes('--host') });
    console.log(`Verified exact archive bytes and both installation strategies for ${result.size} native platform(s).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
