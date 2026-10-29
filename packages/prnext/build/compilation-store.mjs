// Optional content-addressed compilation outputs. Records contain metadata and
// references only; binary output bytes are shared across compilation graphs.
import { constants } from 'node:fs';
import { open, lstat, rename, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { deflateRaw, inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { cacheHash } from './persistent-cache.mjs';

const compress = promisify(deflateRaw), decompress = promisify(inflateRaw);
const MAGIC = Buffer.from('PRNG2\0');
const HEADER = MAGIC.length + 1 + 4 + 32;
const MAX_BLOB = 16 * 1024 * 1024, MAX_RECORD = 16 * 1024 * 1024;
const MAX_DISK = 64 * 1024 * 1024, MAX_SCAN = 8192, MAX_RECORDS = 1024;
const digest = /^[a-f0-9]{64}$/;
const namePattern = /^([a-f0-9]{64})\.(graph|blob)$/;

async function encode(bytes) {
  let payload = bytes, codec = 0;
  if (bytes.length >= 16384) {
    const packed = await compress(bytes, { level: 1 });
    if (packed.length < bytes.length * 0.9) { payload = packed; codec = 1; }
  }
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header); header[MAGIC.length] = codec;
  header.writeUInt32BE(bytes.length, MAGIC.length + 1);
  Buffer.from(cacheHash(bytes), 'hex').copy(header, MAGIC.length + 5);
  return [header, payload];
}

async function read(directory, name, limit) {
  let file;
  try {
    const filename = path.join(directory, name), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit + HEADER || info.size < HEADER) return null;
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit + HEADER) return null;
    const packed = await file.readFile();
    if (!packed.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const size = packed.readUInt32BE(MAGIC.length + 1), codec = packed[MAGIC.length];
    if (size > limit || codec > 1) return null;
    const payload = packed.subarray(HEADER);
    const bytes = codec ? await decompress(payload, { maxOutputLength: Math.max(1, size) }) : payload;
    if (bytes.length !== size || cacheHash(bytes) !== packed.subarray(MAGIC.length + 5, HEADER).toString('hex')) return null;
    return bytes;
  } catch { return null; } finally { await file?.close().catch(() => {}); }
}

async function write(directory, name, bytes) {
  const filename = path.join(directory, name), temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    const parts = await encode(bytes), file = await open(temporary, 'wx', 0o600);
    try { for (const part of parts) await file.writeFile(part); } finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await unlink(temporary).catch(() => {}); }
}

function references(record) {
  const files = record?.value?.files;
  if (record?.format !== 2 || !Array.isArray(files) || files.length > 4096) return null;
  if (!files.every(file => Array.isArray(file) && file.length === 4 && typeof file[0] === 'string' && digest.test(file[1]) && typeof file[2] === 'string' && Number.isInteger(file[3]) && file[3] >= 0 && file[3] <= MAX_BLOB)) return null;
  if (files.reduce((sum, file) => sum + file[3], 0) > 48 * 1024 * 1024) return null;
  return files;
}

export async function readCompilationRecord(directory, key) {
  if (!directory || !digest.test(key)) return null;
  try {
    const bytes = await read(directory, key + '.graph', MAX_RECORD);
    if (!bytes) return null;
    const record = deserialize(bytes), files = references(record);
    if (!files || record.cacheKey !== key) return null;
    const blobs = new Map(), restored = [];
    for (const [name, id, hash, size] of files) {
      let value = blobs.get(id);
      if (!value) {
        value = await read(directory, id + '.blob', MAX_BLOB);
        if (!value || value.length !== size || cacheHash(value) !== id) return null;
        blobs.set(id, value);
      }
      if (value.length !== size) return null;
      restored.push([name, value, hash]);
    }
    return { ...record, format: 1, value: { ...record.value, files: restored } };
  } catch { return null; }
}

// Concurrent eviction may turn a read into a miss, never into a partial hit.
// Retain the newest complete records and their shared blobs within one budget.
export async function pruneCompilationRecords(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.slice(0, MAX_SCAN)) {
      if (!entry.isFile() || !namePattern.test(entry.name)) continue;
      const info = await lstat(path.join(directory, entry.name));
      if (info.isFile() && !info.isSymbolicLink()) files.push({ name: entry.name, size: info.size, time: info.mtimeMs });
    }
    const blobs = new Map(files.filter(file => file.name.endsWith('.blob')).map(file => [file.name.slice(0, -5), file]));
    const retained = new Set(); let total = 0, count = 0;
    for (const file of files.filter(file => file.name.endsWith('.graph')).sort((a, b) => b.time - a.time)) {
      let refs;
      try { const bytes = await read(directory, file.name, MAX_RECORD); refs = bytes && references(deserialize(bytes)); } catch {}
      const ids = refs && [...new Set(refs.map(item => item[1]))];
      const added = file.size + (ids || []).reduce((sum, id) => sum + (retained.has(id + '.blob') ? 0 : blobs.get(id)?.size ?? MAX_DISK), 0);
      if (ids && ids.every(id => blobs.has(id)) && count < MAX_RECORDS && total + added <= MAX_DISK) {
        retained.add(file.name); for (const id of ids) retained.add(id + '.blob');
        total += added; count++;
      }
    }
    for (const file of files) if (!retained.has(file.name)) await unlink(path.join(directory, file.name)).catch(() => {});
  } catch { /* Disk cache maintenance cannot fail a build. */ }
}

export async function writeCompilationRecord(directory, key, record) {
  if (!directory || !digest.test(key)) return false;
  try {
    const files = [], written = new Set();
    for (const [name, data, hash] of record.value.files) {
      if (!(data instanceof Uint8Array) || data.byteLength > MAX_BLOB) return false;
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength), id = cacheHash(bytes);
      files.push([name, id, hash, bytes.length]);
      if (!written.has(id)) {
        // Verify existing bytes before reuse, including a corrupted blob from an
        // interrupted previous build. Atomic replacement repairs that entry.
        const existing = await read(directory, id + '.blob', MAX_BLOB);
        if (!existing || cacheHash(existing) !== id) await write(directory, id + '.blob', bytes);
        written.add(id);
      }
    }
    const saved = { ...record, format: 2, cacheKey: key, value: { ...record.value, files } };
    if (!references(saved)) return false;
    const bytes = serialize(saved);
    if (bytes.length > MAX_RECORD) return false;
    await write(directory, key + '.graph', bytes);
    await pruneCompilationRecords(directory);
    return true;
  } catch { return false; }
}
