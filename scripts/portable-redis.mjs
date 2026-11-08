import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

export const redisArchive = {
  url: 'https://github.com/redis-windows/redis-windows/releases/download/8.10.3/Redis-8.10.3-Windows-x64-msys2.zip',
  sha256: 'af16df340525b431e9ec8dabfd625d5e7a233f82805b5418819904ea909c447f',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function ensureWindowsRedis(directory, { fetchImpl = fetch, expected = redisArchive } = {}) {
  directory = path.resolve(directory); assert.ok(!/[\r\n]/.test(directory));
  await mkdir(directory, { recursive: true }); assert.ok(!(await lstat(directory)).isSymbolicLink());
  const zip = path.join(directory, 'redis.zip'); let bytes;
  try { assert.ok((await lstat(zip)).isFile() && !(await lstat(zip)).isSymbolicLink()); bytes = await readFile(zip); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const response = await fetchImpl(expected.url, { signal: AbortSignal.timeout(60000) }); assert.ok(response.ok && response.body, 'Redis archive download failed');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; assert.ok(size <= 64 * 1024 ** 2, 'Redis archive exceeds its bound'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    bytes = Buffer.concat(chunks, size); assert.equal(digest(bytes), expected.sha256, 'Redis archive checksum mismatch'); await writeFile(zip, bytes, { flag: 'wx' });
  }
  assert.ok(bytes.length <= 64 * 1024 ** 2); assert.equal(digest(bytes), expected.sha256, 'Redis archive checksum mismatch');
  let count = 0, total = 0;
  const entries = unzipSync(bytes, { filter: entry => {
    const name = entry.name.replace(/\/$/, '');
    assert.ok(name && !/[\\\r\n\0:]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe Redis archive path');
    assert.ok(++count <= 2048 && entry.originalSize <= 64 * 1024 ** 2 && (total += entry.originalSize) <= 256 * 1024 ** 2, 'Redis extraction exceeds its bound');
    return !entry.name.endsWith('/');
  } });
  const binaries = Object.keys(entries).filter(name => path.posix.basename(name) === 'redis-server.exe'); assert.equal(binaries.length, 1, 'Redis executable missing or ambiguous');
  for (const [name, body] of Object.entries(entries)) {
    const file = path.join(directory, 'extracted', ...name.split('/')); await mkdir(path.dirname(file), { recursive: true });
    assert.ok((await realpath(path.dirname(file))).startsWith((await realpath(directory)) + path.sep));
    try { assert.ok(!(await lstat(file)).isSymbolicLink()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Re-materialize from the pinned ZIP, including adjacent DLLs. An edited
    // executable or DLL in this disposable cache never becomes trusted input.
    await writeFile(file, body);
  }
  return path.join(directory, 'extracted', ...binaries[0].split('/'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length === 4 && process.argv[2] === '--directory'); const binary = await ensureWindowsRedis(process.argv[3]);
    if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `PRNEXT_REDIS_SERVER=${binary}\n`);
    console.log('Prepared isolated Redis executable: ' + binary);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
