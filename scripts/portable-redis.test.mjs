import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync } from 'fflate';
import { ensureWindowsRedis } from './portable-redis.mjs';

async function fixture(t, files = { 'bin/redis-server.exe': Buffer.from('fixture'), 'bin/msys.dll': Buffer.from('owned DLL') }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'prnext-redis-input-')); t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const bytes = Buffer.from(zipSync(files)), expected = { url: 'https://fixture.invalid/redis', sha256: createHash('sha256').update(bytes).digest('hex') };
  let downloads = 0; return { directory, expected, downloads: () => downloads, options: { expected, fetchImpl: async () => { downloads++; return new Response(bytes); } } };
}
test('portable Redis uses one pinned download and restores edited adjacent DLLs from those exact bytes', async t => {
  const f = await fixture(t), binary = await ensureWindowsRedis(f.directory, f.options);
  assert.equal(await readFile(binary, 'utf8'), 'fixture'); await writeFile(path.join(path.dirname(binary), 'msys.dll'), 'changed');
  assert.equal(await ensureWindowsRedis(f.directory, f.options), binary); assert.equal(f.downloads(), 1);
  assert.equal(await readFile(path.join(path.dirname(binary), 'msys.dll'), 'utf8'), 'owned DLL');
});
test('wrong checksums and unsafe or ambiguous Redis archives fail before an executable is returned', async t => {
  const f = await fixture(t); await assert.rejects(ensureWindowsRedis(f.directory, { ...f.options, expected: { ...f.expected, sha256: '0'.repeat(64) } }), /checksum/);
  for (const files of [{ '../redis-server.exe': Buffer.from('unsafe') }, { 'one/redis-server.exe': Buffer.from('a'), 'two/redis-server.exe': Buffer.from('b') }]) {
    const item = await fixture(t, files); await assert.rejects(ensureWindowsRedis(item.directory, item.options), /Unsafe|ambiguous/);
  }
});
