import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rm, stat, utimes, mkdir, copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';

async function digest(stream, limit = Infinity) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error('Precompression cache exceeds source size'), { code: 'CACHE_SIZE' });
    hash.update(chunk);
  }
  return hash.digest('hex');
}
async function trimCache(directory) {
  const entries = (await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.gz$/.test(name)).map(async name => {
    try { return {name, ...await stat(path.join(directory,name))}; } catch(error) { if(error.code==='ENOENT')return null; throw error; }
  }))).filter(Boolean).sort((a,b)=>b.mtimeMs-a.mtimeMs);
  let bytes = 0;
  for (let index=0;index<entries.length;index++) {
    bytes += entries[index].size;
    if(index>=512 || bytes>64*1024*1024)await rm(path.join(directory,entries[index].name),{force:true});
  }
}

// Images, archives and WOFF fonts already contain compressed data. Only build
// outputs with useful gzip representations are candidates; public stays mutable.
const compressibleExtensions = new Set([
  '.html', '.htm', '.js', '.mjs', '.cjs', '.css', '.json', '.map', '.svg',
  '.xml', '.txt', '.csv', '.md', '.webmanifest', '.wasm', '.ttf', '.otf', '.eot',
]);

async function* files(directory, additional) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(filename, additional);
    else if (entry.isFile() && (compressibleExtensions.has(path.extname(entry.name).toLowerCase()) || additional.has(filename))) yield filename;
  }
}

async function compress(filename, cacheDirectory) {
  const original = await stat(filename);
  if (!original.size) return 'skipped';
  const sidecar = filename + '.gz';
  const key = cacheDirectory && original.size <= 64*1024*1024 ? await digest(createReadStream(filename)) : null;
  const cached = key && path.join(cacheDirectory,key+'.gz');
  let reused = false;
  try {
    if (cached) {
      try {
        if ((await stat(cached)).size <= 4*1024*1024) {
          // Validate cached content, including gzip CRC, using bounded buffers.
          // A corrupt cache is a miss, never a corrupt published response.
          const input = createReadStream(cached), unzip = createGunzip();
          const verified = digest(unzip, original.size);
          const pumping = pipeline(input,unzip);
          const [actual] = await Promise.all([verified,pumping]);
          if (actual === key) { await copyFile(cached,sidecar); reused = true; }
        }
      } catch (error) { if (!['ENOENT','ENOTDIR','Z_DATA_ERROR','Z_BUF_ERROR','CACHE_SIZE'].includes(error.code)) throw error; }
    }
    if (!reused) await pipeline(createReadStream(filename), createGzip(), createWriteStream(sidecar, { flags: 'wx' }));
    if ((await stat(sidecar)).size >= original.size) {
      await rm(sidecar);
      return 'skipped';
    }
    // Node cannot set arbitrary nanosecond timestamps. Use the same conversion
    // for both immutable outputs so the server's exact freshness check succeeds.
    const accessed = original.atimeMs / 1000;
    const modified = original.mtimeMs / 1000;
    await utimes(filename, accessed, modified);
    await utimes(sidecar, accessed, modified);
    if (cached && !reused && (await stat(sidecar)).size <= 4*1024*1024) {
      await mkdir(cacheDirectory,{recursive:true});
      const temporary=cached+'.'+randomUUID()+'.tmp';
      try { await copyFile(sidecar,temporary); await rename(temporary,cached); }
      finally { await rm(temporary,{force:true}); }
      await trimCache(cacheDirectory);
    }
    return reused ? 'reused' : 'compressed';
  } catch (error) {
    await rm(sidecar, { force: true });
    throw error;
  }
}

/** Precompress unpublished build assets with bounded buffers and two workers. */
export async function precompressBuild(stage, manifest, {cacheDirectory} = {}) {
  const stats = {compressed:0,reused:0,skipped:0};
  // Route Handler bodies are opaque bytes. Only consider published, unencoded
  // response artifacts; the size check also rejects incompressible binary data.
  const additional = new Set((manifest?.prerendered || []).filter(record =>
    !record.dataFile && record.file?.endsWith('.body') &&
    !Object.keys(record.headers || {}).some(name => name.toLowerCase() === 'content-encoding')
  ).map(record => path.resolve(stage, record.file)));
  async function* candidates() {
    yield* files(path.resolve(stage, 'static'), additional);
    yield* files(path.resolve(stage, 'assets'), additional);
  }
  const iterator = candidates();
  let failure;
  const worker = async () => {
    while (!failure) {
      try {
        const next = await iterator.next();
        if (next.done) return;
        stats[await compress(next.value, cacheDirectory)]++;
      } catch (error) { failure ||= error; }
    }
  };
  // Wait for both pipelines before reporting failure: the caller can then
  // discard the staging directory without racing another compressor.
  await Promise.all([worker(), worker()]);
  if (failure) throw failure;
  return stats;
}
