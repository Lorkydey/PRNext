import { createHash } from 'node:crypto';
import {sourceMapsEnabled} from './source-maps.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {buildCacheIdentity,privateCacheDirectory,readCacheRecord,writeCacheRecord} from './persistent-cache.mjs';

const entries = new Map();
const byteLimit = 2 * 1024 * 1024, entryLimit = 256, itemLimit = 128 * 1024;
let bytes = 0, hits = 0, misses = 0;
let diskHits=0,diskWrites=0;
const persistent=new AsyncLocalStorage();
export const transformCacheStats = () => ({entries:entries.size,bytes,hits,misses,diskHits,diskWrites});
export async function withPersistentTransforms(root,{enabled=true,dev=false}={},run){
  if(!enabled||process.env.PRNEXT_BUILD_CACHE==='0')return run();
  let directory,key,record;
  try{directory=await privateCacheDirectory(root,dev?'transforms-dev-v1':'transforms-v1');key=directory&&await buildCacheIdentity(root);record=key&&await readCacheRecord(directory,key);}catch{return run();}
  if(!directory||!key)return run();
  const scope={key,values:new Map(),bytes:0,dirty:false};
  for(const item of Array.isArray(record?.entries)?record.entries.slice(-4096):[]){
    if(!Array.isArray(item)||item.length!==2||!/^[a-f0-9]{64}$/.test(item[0])||typeof item[1]!=='string')continue;
    const size=Buffer.byteLength(item[1]);if(size>128*1024||scope.bytes+size>8*1024*1024)continue;
    scope.values.set(item[0],item[1]);scope.bytes+=size;
  }
  const result=await persistent.run(scope,run);
  if(scope.dirty&&await writeCacheRecord(directory,key,{entries:[...scope.values]}))diskWrites++;
  return result;
}
function identity(kind,source,settings){return createHash('sha256').update(persistent.getStore()?.key||'memory').update(JSON.stringify([kind,settings,sourceMapsEnabled()])).update('\0').update(source).digest('hex');}
function diskValue(key){const scope=persistent.getStore();if(!scope?.values.has(key))return;const value=scope.values.get(key);scope.values.delete(key);scope.values.set(key,value);diskHits++;hits++;return value;}
function remember(key,output){
  const scope=persistent.getStore();if(!scope||typeof output!=='string')return;
  const size=Buffer.byteLength(output);if(size>128*1024)return;
  const previous=scope.values.get(key);if(previous!==undefined){scope.bytes-=Buffer.byteLength(previous);scope.values.delete(key);}
  while(scope.values.size&&(scope.values.size>=4096||scope.bytes+size>8*1024*1024)){const [old,value]=scope.values.entries().next().value;scope.values.delete(old);scope.bytes-=Buffer.byteLength(value);}
  scope.values.set(key,output);scope.bytes+=size;scope.dirty=true;
}

// Only pure string transformations belong here. No AST, input source, plugin
// closure or mutable build metadata survives in the cache. Include all options
// affecting output in settings, including build identity and target mode.
export function cachedTransform(kind, source, settings, transform) {
  const key = identity(kind,source,settings);
  const found = entries.get(key);
  if (found) {
    hits++; entries.delete(key); entries.set(key,found);
    if(persistent.getStore()&&!persistent.getStore().values.has(key))remember(key,found.output);
    return found.output;
  }
  const saved=diskValue(key);if(saved!==undefined)return saved;
  misses++;
  const output = transform();
  remember(key,output);
  // UTF-16 is an upper bound for the retained string payload. Metadata adds
  // engine overhead; the entry count also bounds that overhead.
  const size = output.length * 2 + key.length * 2;
  if (size <= itemLimit) {
    while (entries.size && (entries.size >= entryLimit || bytes + size > byteLimit)) {
      const [oldest,value] = entries.entries().next().value;
      entries.delete(oldest); bytes -= value.size;
    }
    entries.set(key,{output,size}); bytes += size;
  }
  return output;
}

/** Async transforms share the same payload and entry budget as synchronous ones. */
export async function cachedAsyncTransform(kind, source, settings, transform) {
  const key = identity(kind,source,settings);
  const found = entries.get(key);
  if (found) { hits++; entries.delete(key); entries.set(key,found); if(persistent.getStore()&&!persistent.getStore().values.has(key))remember(key,found.output);return found.output; }
  const saved=diskValue(key);if(saved!==undefined)return saved;
  misses++;
  const output = await transform();
  remember(key,output);
  const size = output.length * 2 + key.length * 2;
  if (size <= itemLimit) {
    if (entries.has(key)) {bytes -= entries.get(key).size;entries.delete(key);}
    while (entries.size && (entries.size >= entryLimit || bytes + size > byteLimit)) {
      const [oldest,value] = entries.entries().next().value;entries.delete(oldest);bytes -= value.size;
    }
    entries.set(key,{output,size});bytes += size;
  }
  return output;
}
