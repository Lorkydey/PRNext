import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot } from './cargo.mjs';
import { packageRoot, packageManifest, nativePlatform, nativeBinaryName } from '../packages/prnext/native/resolve.mjs';
import { archiveDigest, archiveFilename, readArchive } from './verify-npm-artifacts.mjs';

// A prepared archive is an input to tests, never evidence that those tests ran.
export async function readPreparedArchives(directory, { sourceRoot = packageRoot, sourceManifest = packageManifest, target = nativePlatform() } = {}) {
  directory = path.resolve(directory);
  const sealFile = path.join(directory, 'prepared.json');
  const sealInfo = await lstat(sealFile);
  assert.ok(sealInfo.isFile() && !sealInfo.isSymbolicLink() && sealInfo.size < 16384, 'Invalid prepared archive seal');
  const seal = JSON.parse(await readFile(sealFile, 'utf8'));
  assert.equal(seal.schemaVersion, 1);
  assert.equal(seal.version, sourceManifest.version);
  assert.equal(seal.platform, target.id);
  const names = [sourceManifest.name, target.package];
  assert.deepEqual(seal.archives.map(record => record.name).sort(), [...names].sort());
  const result = {};
  for (const [index, name] of names.entries()) {
    const record = seal.archives.find(record => record.name === name);
    const filename = archiveFilename(name, sourceManifest.version), tarball = path.join(directory, filename);
    assert.equal(record.filename, filename);
    const info = await lstat(tarball);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 128 * 1024 ** 2, 'Invalid prepared archive');
    const bytes = await readFile(tarball), digest = archiveDigest(bytes), entries = readArchive(bytes);
    for (const key of ['size', 'sha256', 'integrity']) assert.equal(record[key], digest[key], 'Prepared archive digest mismatch');
    const manifest = JSON.parse(entries.get('package/package.json').data);
    assert.equal(manifest.name, name); assert.equal(manifest.version, sourceManifest.version);
    if (index === 0) {
      assert.equal(entries.get('package/cli.mjs')?.mode, 0o755);
      for (const [entry, value] of entries) {
        const relative = entry.slice('package/'.length);
        assert.ok(value.data.equals(await readFile(path.join(sourceRoot, relative))), 'Prepared framework differs from source: ' + relative);
      }
    } else {
      assert.deepEqual(manifest.os, [target.os]); assert.deepEqual(manifest.cpu, [target.cpu]);
      if (target.libc) assert.deepEqual(manifest.libc, [target.libc]);
      const descriptor = JSON.parse(entries.get('package/native.json').data);
      assert.equal(descriptor.id, target.id); assert.equal(descriptor.version, sourceManifest.version);
      for (const key of ['package', 'os', 'cpu', 'libc']) assert.deepEqual(descriptor[key], target[key], 'Native descriptor target mismatch');
      if (target.os !== 'win32') assert.ok(entries.get('package/bin/' + nativeBinaryName(target.os)).mode & 0o111);
      assert.equal(descriptor.sha256, archiveDigest(entries.get('package/bin/' + nativeBinaryName(target.os)).data).sha256);
    }
    if (index === 1 && seal.publishedNative) {
      assert.equal(seal.publishedNative.registry, 'https://registry.npmjs.org/');
      assert.equal(new URL(seal.publishedNative.tarball).origin, 'https://registry.npmjs.org');
      assert.equal(seal.publishedNative.integrity, digest.integrity);
    }
    result[index === 0 ? 'main' : 'native'] = { ...digest, name, target: target.id, ...(index === 1 && seal.publishedNative ? { published: seal.publishedNative } : {}), version: manifest.version, filename, tarball,
      files: [...entries].map(([entry, value]) => ({ path: entry.slice('package/'.length), size: value.data.length, mode: value.mode })) };
  }
  return result;
}

export async function materializePreparedNative(directory) {
  const { native } = await readPreparedArchives(directory);
  const name = nativeBinaryName(nativePlatform().os);
  const bytes = readArchive(await readFile(native.tarball)).get('package/bin/' + name).data;
  const destination = path.join(repositoryRoot, 'target/release', name);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o755 });
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length === 3, 'Expected a prepared archive directory');
    console.log(await materializePreparedNative(process.argv[2]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
