import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cacheHash } from './persistent-cache.mjs';
import { readCompilationRecord, writeCompilationRecord, pruneCompilationRecords } from './compilation-store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-binary-graphs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const record = bytes => ({ format: 1, snapshot: { files: [], directories: [], excluded: [] }, value: { files: [['entry.js', bytes, 'hash']], metafile: {} } });

test('binary graphs share identical blobs and roundtrip arbitrary bytes and metadata', async t => {
  const dir = await fixture(t), data = randomBytes(32768), first = cacheHash('a'), second = cacheHash('b');
  assert.equal(await writeCompilationRecord(dir, first, record(data)), true);
  assert.equal(await writeCompilationRecord(dir, second, record(data)), true);
  assert.equal((await readdir(dir)).filter(name => name.endsWith('.blob')).length, 1);
  const restored = await readCompilationRecord(dir, second);
  assert.deepEqual(restored.value.files[0][1], data);
  assert.deepEqual(restored.snapshot, record(data).snapshot);
  assert.equal((await readdir(dir)).some(name => name.endsWith('.tmp')), false);
  const other = cacheHash('wrong-settings');
  await writeFile(path.join(dir, other + '.graph'), await readFile(path.join(dir, first + '.graph')));
  assert.equal(await readCompilationRecord(dir, other), null, 'a valid record from different compiler settings is a miss');
});

test('selective compression shrinks repetitive output; corruption or missing blobs is a miss and can be repaired', async t => {
  const dir = await fixture(t), key = cacheHash('large'), data = Buffer.from('export const answer = 42;\n'.repeat(10000));
  await writeCompilationRecord(dir, key, record(data));
  const blob = path.join(dir, (await readdir(dir)).find(name => name.endsWith('.blob')));
  assert.ok((await readFile(blob)).length < data.length / 10);
  assert.deepEqual((await readCompilationRecord(dir, key)).value.files[0][1], data);
  const corrupt = await readFile(blob); corrupt[corrupt.length - 1] ^= 255; await writeFile(blob, corrupt);
  assert.equal(await readCompilationRecord(dir, key), null);
  await writeCompilationRecord(dir, key, record(data));
  assert.deepEqual((await readCompilationRecord(dir, key)).value.files[0][1], data);
  await rm(blob); assert.equal(await readCompilationRecord(dir, key), null);
});

test('orphaned blobs are pruned and oversized or malformed records cannot be read', async t => {
  const dir = await fixture(t), key = cacheHash('keep'), data = Buffer.from([0, 255, 128]);
  await writeCompilationRecord(dir, key, record(data));
  const orphan = path.join(dir, cacheHash('orphan') + '.blob'); await writeFile(orphan, randomBytes(20));
  await pruneCompilationRecords(dir); assert.equal((await readdir(dir)).includes(path.basename(orphan)), false);
  const graph = path.join(dir, key + '.graph'), bytes = await readFile(graph);
  bytes.writeUInt32BE(0xffffffff, 7); await writeFile(graph, bytes);
  assert.equal(await readCompilationRecord(dir, key), null);
  assert.equal(await writeCompilationRecord(dir, '../escape', record(data)), false);
  assert.equal(await readCompilationRecord(dir, '../escape'), null);
});

test('a symlinked graph never supplies executable compilation outputs', { skip: process.platform === 'win32' }, async t => {
  const dir = await fixture(t), key = cacheHash('link'), other = cacheHash('real');
  await writeCompilationRecord(dir, other, record(Buffer.from('safe')));
  await symlink(path.join(dir, other + '.graph'), path.join(dir, key + '.graph'));
  assert.equal(await readCompilationRecord(dir, key), null);
});
