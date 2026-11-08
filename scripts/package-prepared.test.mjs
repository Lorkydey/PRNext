import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readPreparedArchives } from './package-prepared.mjs';
import { archiveDigest, archiveFilename } from './verify-npm-artifacts.mjs';
import { nativeBinaryName } from '../packages/prnext/native/resolve.mjs';

function archive(files) {
  const pieces = [];
  for (const [file, bytes] of Object.entries(files)) {
    const data = Buffer.from(bytes), header = Buffer.alloc(512), octal = (at, length, value) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', at, length);
    header.write('package/' + file); octal(100, 8, 0o755); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, 0);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
    octal(148, 8, header.reduce((a, b) => a + b, 0)); pieces.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...pieces, Buffer.alloc(1024)]));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'prnext-prepared-input-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const sourceRoot = path.join(root, 'source'), directory = path.join(root, 'prepared'); await mkdir(sourceRoot); await mkdir(directory);
  const sourceManifest = { name: '@fixture/framework', version: '1.2.3' }, target = { id: 'fixture-native', package: '@fixture/native', os: process.platform, cpu: process.arch };
  const files = { 'package.json': JSON.stringify(sourceManifest), 'cli.mjs': '#!/usr/bin/env node\n' };
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(sourceRoot, name), data);
  const binary = Buffer.from('never executed fixture binary'), native = archive({ 'package.json': JSON.stringify({ name: target.package, version: sourceManifest.version, os: [target.os], cpu: [target.cpu] }),
    'native.json': JSON.stringify({ ...target, version: sourceManifest.version, sha256: archiveDigest(binary).sha256 }), ['bin/' + nativeBinaryName(target.os)]: binary });
  const seal = { schemaVersion: 1, version: sourceManifest.version, platform: target.id, archives: [] };
  for (const [name, bytes] of [[sourceManifest.name, archive(files)], [target.package, native]]) {
    const filename = archiveFilename(name, sourceManifest.version); await writeFile(path.join(directory, filename), bytes); seal.archives.push({ name, filename, ...archiveDigest(bytes) });
  }
  const save = () => writeFile(path.join(directory, 'prepared.json'), JSON.stringify(seal)); await save();
  return { directory, sourceRoot, sourceManifest, target, seal, save, read: () => readPreparedArchives(directory, { sourceRoot, sourceManifest, target }) };
}

test('prepared inputs bind the same archives to the current source and native target without repacking', async t => {
  const f = await fixture(t), result = await f.read();
  assert.equal(result.main.name, f.sourceManifest.name); assert.equal(result.native.target, f.target.id);
  assert.ok(result.main.files.some(file => file.path === 'cli.mjs'));
  await writeFile(path.join(f.sourceRoot, 'cli.mjs'), 'changed source'); await assert.rejects(f.read, /differs from source/);
});

test('prepared archive tampering, wrong platform and duplicate records fail before installation', async t => {
  const f = await fixture(t);
  f.seal.platform = 'another-platform'; await f.save(); await assert.rejects(f.read);
  f.seal.platform = f.target.id; f.seal.archives[0].sha256 = '0'.repeat(64); await f.save(); await assert.rejects(f.read, /digest/);
  f.seal.archives.push(f.seal.archives[0]); await f.save(); await assert.rejects(f.read);
});
