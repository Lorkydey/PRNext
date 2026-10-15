import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_TOTAL = 64 * 1024 * 1024;
let writes = Promise.resolve();

/** Project-local build inputs, never responses/user data. Clearing this directory
 * refreshes Google assets. A warm cache also permits an offline rebuild.
 */
export async function cachedFontResource(root, url, maximum, accept, download) {
  if (!root) return download();
  const directory = path.join(root, '.prnext-cache', 'fonts-v1');
  const file = path.join(directory, hash(JSON.stringify([url, accept])) + '.bin');
  try {
    const metadata = await lstat(file);
    if (metadata.isFile() && metadata.size > 65 && metadata.size <= maximum + 65) {
      const stored = await readFile(file);
      const bytes = stored.subarray(65);
      if (stored[64] === 10 && hash(bytes) === stored.toString('ascii', 0, 64)) return bytes;
    }
  } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
  const bytes = await download();
  if (!bytes.length || bytes.length > maximum) throw new Error('Font resource exceeds its cache input limit');
  const task = writes.catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, Buffer.concat([Buffer.from(hash(bytes) + '\n'), bytes]), { flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    const entries = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isFile() || !/^[a-f0-9]{64}\.bin$/.test(item.name)) continue;
      try { entries.push({ file: path.join(directory, item.name), ...await lstat(path.join(directory, item.name)) }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = 0;
    for (let index = 0; index < entries.length; index++) {
      total += entries[index].size;
      if (index >= 256 || total > MAX_TOTAL) await rm(entries[index].file, { force: true });
    }
  });
  writes = task;
  try { await task; }
  catch (error) { if (!['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT'].includes(error.code)) throw error; }
  return bytes;
}
