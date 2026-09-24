'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateTags, cacheState, getCachePaths } = require('./data-cache.cjs');
const MAX_BYTES = 2 * 1024 * 1024;
const modules = new Map();
const requests = new WeakMap();
const revisions = new WeakMap();
const owners = new WeakMap();
let pendingCount = 0;

function configured(context) { return context?.cacheHandlers || context?.manifest?.config?.cacheHandlers || {}; }
function outsideRequest(callback) { return require('./headers.cjs').runWithoutRequestContext(callback); }
function wait(promise, signal, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error('Cache handler operation timed out')), Math.max(1, timeoutMs));
    timer.unref();
    function finish(callback, value) { clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value); }
    function abort() { finish(reject, signal.reason); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function call(handler, method, args, context) {
  return wait(outsideRequest(() => Promise.resolve().then(() => handler[method](...args))), context?.signal);
}
function softTags(context) {
  // Next's implicit tags use /layout and /page suffixes and the _N_T_ prefix.
  return [...new Set(getCachePaths(context).map(value => {
    const separator = value.indexOf(':');
    return '_N_T_' + value.slice(separator + 1).replace(/\/$/, '') + '/' + value.slice(0, separator);
  }).concat(context?.url ? ['_N_T_' + (new URL(context.url).pathname.replace(/\/$/, '') || '/')] : []))];
}
async function load(context, kind) {
  const source = configured(context)[kind];
  if (!source) return undefined;
  if (!context.distDir) throw new Error('Custom cache handlers require a build directory');
  const root = path.resolve(context.distDir);
  const file = path.resolve(root, source);
  if (!source.startsWith('server/') || !file.startsWith(root + path.sep)) throw new Error('Invalid cache handler module path');
  let pending = modules.get(file);
  if (!pending) {
    pending = outsideRequest(() => import(pathToFileURL(file).href)).then(module => {
      const handler = module.default;
      if (!handler || ['get', 'set', 'refreshTags', 'getExpiration', 'updateTags'].some(name => typeof handler[name] !== 'function')) throw new TypeError(`cacheHandlers.${kind} must export get, set, refreshTags, getExpiration and updateTags methods`);
      return handler;
    });
    // Production workers have a single build. Bound this lookup for direct runtime callers.
    if (modules.size >= 32) modules.delete(modules.keys().next().value);
    modules.set(file, pending);
  }
  return wait(pending, context.signal);
}
async function refresh(handler, context) {
  let refreshed = requests.get(context);
  if (!refreshed) requests.set(context, refreshed = new Map());
  if (!refreshed.has(handler)) refreshed.set(handler, call(handler, 'refreshTags', [], context));
  return refreshed.get(handler);
}
function metadata(entry) {
  if (!entry || !entry.value || typeof entry.value.getReader !== 'function' || typeof entry.value.cancel !== 'function') throw new TypeError('Invalid CacheEntry stream');
  const tags = validateTags(entry.tags);
  for (const field of ['timestamp', 'stale', 'revalidate', 'expire']) if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]) || entry[field] < 0) throw new TypeError(`Invalid CacheEntry ${field}`);
  return { tags, timestamp: entry.timestamp, stale: entry.stale, revalidate: entry.revalidate, expire: entry.expire };
}
async function read(entry, context) {
  const reader = entry.value.getReader();
  const chunks = [];
  let size = 0, complete = false;
  const deadline = Date.now() + 5000;
  let chunksRead = 0;
  try {
    while (true) {
      if (Date.now() >= deadline || ++chunksRead > 10_000) throw new Error('CacheEntry stream exceeded its read budget');
      const { value, done } = await wait(reader.read(), context.signal, deadline - Date.now());
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw new TypeError('CacheEntry streams must contain bytes');
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('CacheEntry exceeds 2 MiB');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function stream(bytes) {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + 64 * 1024);
    controller.enqueue(new Uint8Array(bytes.subarray(offset, end))); offset = end;
  } });
}
async function expiration(handler, tags, context) {
  const value = await call(handler, 'getExpiration', [tags], context);
  if (typeof value !== 'number' || value < 0 || Number.isNaN(value)) throw new TypeError('Cache handler getExpiration must return a nonnegative timestamp');
  return value;
}
async function customCachedValue(key, kind, producer, options) {
  const { context, resolveMetadata } = options;
  const handler = await load(context, kind);
  if (!handler) return undefined;
  const state = cacheState(context);
  await state.invalidations;
  context.signal?.throwIfAborted();
  const tags = softTags(context);
  let entry, info, bytes;
  try {
    await refresh(handler, context);
    const tagTime = await expiration(handler, tags, context);
    entry = await call(handler, 'get', [key, tags], context);
    if (entry) {
      info = metadata(entry);
      const age = Date.now() - info.timestamp;
      if ((tagTime === Infinity || tagTime < info.timestamp) && age < info.expire * 1000 && (!context.staticState || age < info.revalidate * 1000)) bytes = await read(entry, context);
      else void entry.value.cancel().catch(() => {});
    }
  } catch {
    context.signal?.throwIfAborted();
    if (typeof entry?.value?.cancel === 'function' && !entry.value.locked) void entry.value.cancel().catch(() => {});
  }
  const stale = bytes && Date.now() - info.timestamp >= info.revalidate * 1000;
  if (bytes) options.onReadMetadata?.(info);
  if (bytes && !stale) return bytes;
  let pending = owners.get(handler);
  if (!pending) owners.set(handler, pending = new Map());
  const existing = pending.get(key);
  // A post-mutation reader must not join a producer started before invalidation.
  // Preventing that producer's write alone would still return its old value.
  const joined = options.allowJoin !== false && existing?.revision === (revisions.get(handler) || 0) ? existing : undefined;
  let work = joined?.work;
  if (!work) {
    const revision = revisions.get(handler) || 0;
    const timestamp = performance.timeOrigin + performance.now();
    const record = { revision, timestamp, work: undefined, metadata: undefined };
    work = (async () => {
      const result = await producer();
      const info = resolveMetadata();
      record.metadata = info;
      if (result.byteLength <= MAX_BYTES && revision === (revisions.get(handler) || 0)) {
        try {
          const changed = await expiration(handler, [...new Set([...tags, ...info.tags])], context);
          // Many backends record Date.now() millisecond timestamps. Treat the
          // same millisecond conservatively so fractional producer times cannot
          // hide an invalidation which actually happened after the read started.
          if ((changed === Infinity || changed < Math.floor(timestamp)) && revision === (revisions.get(handler) || 0)) {
            const value = stream(result);
            try { await call(handler, 'set', [key, Promise.resolve({ value, tags: info.tags, stale: info.stale, revalidate: info.revalidate, expire: info.expire, timestamp })], context); }
            catch { if (!value.locked) void value.cancel().catch(() => {}); }
          }
        } catch { context.signal?.throwIfAborted(); }
      }
      return result;
    })();
    record.work = work;
    if (pendingCount < 64) {
      pendingCount++; pending.set(key, record);
      const cleanup = () => { if (pending.get(key) === record) pending.delete(key); pendingCount--; };
      void work.then(cleanup, cleanup);
    }
  }
  if (stale) {
    const background = work.catch(() => {});
    state.pending.add(background);
    void background.finally(() => state.pending.delete(background));
    return bytes;
  }
  const result = await work;
  if (joined) {
    let invalidated = joined.revision !== (revisions.get(handler) || 0);
    let confirmed;
    try {
      const changed = await expiration(handler, [...new Set([...tags, ...(joined.metadata?.tags || [])])], context);
      // Infinity delegates expiration to handler.get; it is not an invalidation
      // timestamp. A finite timestamp can expose a different instance's update.
      invalidated ||= changed !== Infinity && changed >= Math.floor(joined.timestamp);
      if (changed === Infinity && !invalidated) {
        // The backend may know about an invalidation that this worker cannot
        // observe through getExpiration. Re-read its published value instead of
        // trusting the result returned directly by the older producer.
        confirmed = await call(handler, 'get', [key, tags], context);
        if (confirmed) {
          const confirmedInfo = metadata(confirmed);
          const age = Date.now() - confirmedInfo.timestamp;
          if (age < Math.min(confirmedInfo.expire, confirmedInfo.revalidate) * 1000) {
            const confirmedBytes = await read(confirmed, context);
            options.onReadMetadata?.(confirmedInfo);
            return confirmedBytes;
          }
          void confirmed.value.cancel().catch(() => {});
        }
        invalidated = true;
      }
    } catch {
      context.signal?.throwIfAborted(); invalidated = true;
      if (typeof confirmed?.value?.cancel === 'function' && !confirmed.value.locked) void confirmed.value.cancel().catch(() => {});
    }
    // Only a joined reader retries, at most once, and cannot join another old
    // producer on that attempt. The original caller's producer is never replayed.
    if (invalidated) return customCachedValue(key, kind, producer, { ...options, allowJoin: false });
  }
  return result;
}
async function invalidateHandlers(context, operation) {
  const tags = [...(operation.tags || []), ...(operation.paths || []).map(value => {
    const separator = value.indexOf(':');
    return '_N_T_' + value.slice(separator + 1).replace(/\/$/, '') + '/' + value.slice(0, separator);
  })];
  const durations = operation.mode === 'expire' ? { expire: 0 } : operation.expire === undefined ? undefined : { expire: operation.expire };
  const seen = new Set();
  for (const kind of Object.keys(configured(context))) {
    const handler = await load(context, kind);
    if (seen.has(handler)) continue;
    seen.add(handler);
    revisions.set(handler, (revisions.get(handler) || 0) + 1);
    await call(handler, 'updateTags', [tags, durations], context);
    requests.get(context)?.delete(handler);
  }
}
module.exports = { configured, customCachedValue, invalidateHandlers, softTags };
