import { createHash } from 'node:crypto';
import {sourceMapsEnabled} from './source-maps.mjs';

const entries = new Map();
const byteLimit = 2 * 1024 * 1024, entryLimit = 256, itemLimit = 128 * 1024;
let bytes = 0, hits = 0, misses = 0;
export const transformCacheStats = () => ({entries:entries.size,bytes,hits,misses});

// Only pure string transformations belong here. No AST, input source, plugin
// closure or mutable build metadata survives in the cache. Include all options
// affecting output in settings, including build identity and target mode.
export function cachedTransform(kind, source, settings, transform) {
  const key = createHash('sha256').update(JSON.stringify([kind,settings,sourceMapsEnabled()])).update('\0').update(source).digest('hex');
  const found = entries.get(key);
  if (found) {
    hits++; entries.delete(key); entries.set(key,found);
    return found.output;
  }
  misses++;
  const output = transform();
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
  const key = createHash('sha256').update(JSON.stringify([kind,settings,sourceMapsEnabled()])).update('\0').update(source).digest('hex');
  const found = entries.get(key);
  if (found) { hits++; entries.delete(key); entries.set(key,found); return found.output; }
  misses++;
  const output = await transform();
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
