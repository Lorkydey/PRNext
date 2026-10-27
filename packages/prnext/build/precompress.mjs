import { rename } from '../runtime/fs.mjs';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rm, stat,lstat, utimes, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip,createBrotliCompress,createBrotliDecompress,constants } from 'node:zlib';
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
// Scan once per build, not after every compressed file. Two compressors share
// this bounded index and serialize publication/eviction, including overwrites.
// Cached bytes are still decoded and hashed before reuse below.
async function compressionCache(directory) {
  if (!directory || process.env.PRNEXT_BUILD_CACHE === '0') return;
  try {
    await mkdir(directory,{recursive:true});
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink())return;
    const entries=[];
    for(const name of await readdir(directory)) {
      if(!/^[a-f0-9]{64}\.(?:gz|br)$/.test(name))continue;
      const info=await lstat(path.join(directory,name)).catch(()=>null);
      if(info?.isFile()&&!info.isSymbolicLink())entries.push({name,size:info.size,time:info.mtimeMs});
    }
    entries.sort((a,b)=>a.time-b.time);
    const index=new Map(entries.map(entry=>[entry.name,entry.size]));
    let bytes=entries.reduce((sum,entry)=>sum+entry.size,0),pending=Promise.resolve(),disabled=false;
    async function trim() {
      while(index.size>512||bytes>64*1024*1024) {
        const [name,size]=index.entries().next().value;
        await rm(path.join(directory,name),{force:true});index.delete(name);bytes-=size;
      }
    }
    await trim();
    return {directory,write(name,source){
      const task=pending.then(async()=>{
        if(disabled)return;
        let temporary;
        try {
          const {size}=await stat(source);if(size>4*1024*1024)return;
          const filename=path.join(directory,name);temporary=filename+'.'+randomUUID()+'.tmp';
          await copyFile(source,temporary);await rename(temporary,filename);
          bytes-=index.get(name)||0;index.delete(name);index.set(name,size);bytes+=size;
          await trim();
        }catch{disabled=true;/* Optional cache failures never invalidate a correct sidecar. */}
        finally{if(temporary)await rm(temporary,{force:true}).catch(()=>{});}
      });
      pending=task.catch(()=>{});return task;
    }};
  }catch{/* Unavailable/corrupt cache metadata is an optimization miss. */}
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

async function compress(filename, cache,format,original,key) {
  if (!original.size) return 'skipped';
  const sidecar = filename + '.'+format;
  const decode=()=>format==='br'?createBrotliDecompress():createGunzip();
  // Static builders may already supply gzip files. Validate them rather than
  // overwriting public input or publishing a mismatched encoded response.
  const existing = await lstat(sidecar).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing) {
    if(!existing.isFile()||existing.isSymbolicLink())throw new Error('Precompressed assets must be regular files: '+path.basename(sidecar));
    const input = createReadStream(sidecar), unzip = decode();
    const verified = digest(unzip, original.size);
    const pumping = pipeline(input, unzip);
    const [actual, expected] = await Promise.all([verified, digest(createReadStream(filename)), pumping]);
    if (actual !== expected) throw new Error(`Precompressed asset does not match its source: ${path.basename(sidecar)}`);
    await utimes(filename, original.atimeMs / 1000, original.mtimeMs / 1000);
    await utimes(sidecar, original.atimeMs / 1000, original.mtimeMs / 1000);
    return 'reused';
  }
  const cached = key && cache && path.join(cache.directory,key+'.'+format);
  let reused = false;
  try {
    if (cached) {
      try {
        const info=await lstat(cached);
        if (info.isFile()&&!info.isSymbolicLink()&&info.size <= 4*1024*1024) {
          // Validate cached content, including gzip CRC, using bounded buffers.
          // A corrupt cache is a miss, never a corrupt published response.
          const input = createReadStream(cached), unzip = decode();
          const verified = digest(unzip, original.size);
          const pumping = pipeline(input,unzip);
          const [actual] = await Promise.all([verified,pumping]);
          if (actual === key) { await copyFile(cached,sidecar); reused = true; }
        }
      } catch { /* Brotli has several decoder-specific error codes. Every invalid cache entry is a miss. */ }
    }
    if (!reused) await pipeline(createReadStream(filename),format==='br'?createBrotliCompress({params:{[constants.BROTLI_PARAM_QUALITY]:5,[constants.BROTLI_PARAM_SIZE_HINT]:Math.min(original.size,0xffffffff)}}):createGzip(), createWriteStream(sidecar, { flags: 'wx' }));
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
    if (cached && !reused) await cache.write(key+'.'+format,sidecar);
    return reused ? 'reused' : 'compressed';
  } catch (error) {
    await rm(sidecar, { force: true });
    throw error;
  }
}

/** Precompress unpublished build assets with bounded buffers and two workers. */
export async function precompressBuild(stage, manifest, {cacheDirectory} = {}) {
  const stats = {compressed:0,reused:0,skipped:0};
  const cache=await compressionCache(cacheDirectory);
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
        const original=await stat(next.value);
        const key=cache&&original.size<=64*1024*1024?await digest(createReadStream(next.value)):null;
        const gzip=await compress(next.value,cache,'gz',original,key);
        const brotli=await compress(next.value,cache,'br',original,key);
        stats[gzip==='compressed'||brotli==='compressed'?'compressed':gzip==='reused'||brotli==='reused'?'reused':'skipped']++;
      } catch (error) { failure ||= error; }
    }
  };
  // Wait for both pipelines before reporting failure: the caller can then
  // discard the staging directory without racing another compressor.
  await Promise.all([worker(), worker()]);
  if (failure) throw failure;
  return stats;
}
