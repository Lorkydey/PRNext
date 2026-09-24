'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { softTags } = require('./cache-handlers.cjs');
const { trackStaticDependency } = require('./static-generation.cjs');
const MAX_BYTES = 2 * 1024 * 1024;
const modules = new Map();
const instances = new WeakMap();
let ownersCount = 0;

function configured(context) { return context?.cacheHandler || context?.manifest?.config?.cacheHandler; }
function outside(callback) { return require('./headers.cjs').runWithoutRequestContext(callback); }
function wait(promise, signal, milliseconds = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error('Incremental cache handler timed out')), milliseconds);
    timer.unref();
    const abort = () => finish(reject, signal.reason);
    function finish(callback, value) { clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value); }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
async function invoke(handler, method, args, context) {
  return wait(outside(() => Promise.resolve().then(() => handler[method](...args))), context?.signal);
}
async function load(context) {
  const source = configured(context);
  if (!source) return undefined;
  let pending = instances.get(context);
  if (pending) return pending;
  const root = path.resolve(context.distDir || '');
  const filename = path.resolve(root, source);
  if (!context.distDir || !source.startsWith('server/') || !filename.startsWith(root + path.sep)) throw new Error('Invalid incremental cache handler path');
  let record = modules.get(filename);
  if (!record) {
    record = { module: outside(() => import(pathToFileURL(filename).href)), revision: 0, owners: new Map() };
    if (modules.size >= 32) modules.delete(modules.keys().next().value);
    modules.set(filename, record);
  }
  pending = (async () => {
    const imported = await wait(record.module, context.signal);
    const Constructor = imported.default;
    if (typeof Constructor !== 'function') throw new TypeError('cacheHandler must export a constructor');
    const handler = outside(() => new Constructor({
      dev: context.production === false, fs: { ...fs.promises, readFileSync: fs.readFileSync, existsSync: fs.existsSync },
      flushToDisk: true, serverDistDir: path.join(root, 'server'), revalidatedTags: [],
      maxMemoryCacheSize: context.cacheMaxMemorySize ?? context.manifest?.config?.cacheMaxMemorySize,
      _requestHeaders: Object.fromEntries(new Headers(context.headers || {})), fetchCacheKeyPrefix: '',
    }));
    if (['get', 'set', 'revalidateTag'].some(name => typeof handler[name] !== 'function')) throw new TypeError('cacheHandler must implement get, set and revalidateTag');
    if (handler.resetRequestCache !== undefined) {
      if (typeof handler.resetRequestCache !== 'function') throw new TypeError('cacheHandler.resetRequestCache must be a function');
      await invoke(handler, 'resetRequestCache', [], context);
    }
    return { handler, record };
  })();
  instances.set(context, pending);
  return pending;
}
async function getEntry(key, kind, context, options = {}) {
  const { handler } = await load(context);
  return invoke(handler, 'get', [key, { kind, ...options }], context);
}
async function setEntry(key, value, context, options = {}) {
  const { handler } = await load(context);
  return invoke(handler, 'set', [key, value, { ...options }], context);
}
async function invalidate(context, operation) {
  const { handler, record } = await load(context);
  record.revision++;
  const tags = [...(operation.tags || []), ...(operation.paths || []).map(value => {
    const separator = value.indexOf(':');
    return '_N_T_' + value.slice(separator + 1).replace(/\/$/, '') + '/' + value.slice(0, separator);
  })];
  const durations = operation.mode === 'expire' ? { expire: 0 } : operation.expire === undefined ? undefined : { expire: operation.expire };
  await invoke(handler, 'revalidateTag', [[...new Set(tags)], durations], context);
}
function fresh(entry, revalidate) {
  const timestamp = entry?.lastModified;
  if (!Number.isFinite(timestamp) || timestamp < 0 || timestamp > Date.now() + 60_000) return false;
  const stored = entry.value?.revalidate;
  const storedTtl = typeof stored === 'number' && Number.isFinite(stored) && stored >= 0 ? stored : Infinity;
  const ttl = Math.min(revalidate === false ? Infinity : revalidate, storedTtl);
  return Date.now() - timestamp < ttl * 1000;
}

/** Keep streaming fetch responses live while only bounded captured bytes enter storage. */
async function cachedIncrementalValue(key, producer, options) {
  const cache = require('./data-cache.cjs');
  const { context, incremental } = options;
  const signal = options.signal || context.signal;
  const state = cache.cacheState(context);
  await state.invalidations;
  signal?.throwIfAborted();
  const { handler, record } = await load(context);
  const tags = cache.validateTags(options.tags);
  const implicit = softTags(context);
  const revalidate = options.revalidate == null ? false : options.revalidate;
  const getContext = { kind: 'FETCH', fetchCache: true, tags, softTags: implicit,
    revalidate, fetchUrl: incremental.url || '', fetchIdx: 0 };
  // PPR artifacts cannot hide invalidations maintained by an external backend.
  if (context.cacheComponents) trackStaticDependency({ externalCache: true }, context);
  let entry, bytes;
  try {
    entry = await invoke(handler, 'get', [key, getContext], context);
    if (entry?.value?.kind === 'FETCH' && typeof entry.lastModified === 'number' && Number.isFinite(entry.lastModified)) {
      bytes = incremental.decode(entry.value);
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) bytes = undefined;
    }
  } catch { signal?.throwIfAborted(); }
  const stale = bytes && !fresh(entry, revalidate);
  if (bytes && !stale) return bytes;
  const existing = record.owners.get(key);
  if (options.join !== false && (!bytes || options.forceFresh || context.staticState) && existing?.revision === record.revision) {
    // Read the backend again after joining: it owns cross-instance invalidation.
    await wait(existing.done, signal, 25_000);
    if (options.join !== false) return cachedIncrementalValue(key, producer, { ...options, join: false });
  }
  if (stale && !options.forceFresh && !context.staticState && existing?.revision === record.revision) return bytes;
  const background = Boolean(stale && !options.forceFresh && !context.staticState);
  const revision = record.revision;
  let complete;
  const owner = { revision, done: new Promise(resolve => { complete = resolve; }) };
  if (ownersCount < 64) { record.owners.set(key, owner); ownersCount++; }
  let lease;
  const cleanup = async () => {
    if (owner.finished) return;
    owner.finished = true;
    try { await lease?.release(); } finally {
    if (record.owners.get(key) === owner) record.owners.delete(key);
    if (owner.tracked) ownersCount--;
    complete();
    }
  };
  owner.tracked = record.owners.get(key) === owner;
  const store = async value => {
    if (value == null || revision !== record.revision) return;
    if (!(value instanceof Uint8Array) || value.byteLength > MAX_BYTES) return;
    if (lease && !await lease.valid()) return;
    const data = incremental.encode(Buffer.from(value));
    const setContext = { ...getContext, tags: [...new Set([...tags, ...implicit])], cacheControl: { revalidate } };
    try {
      await invoke(handler, 'set', [key, { kind: 'FETCH', data, revalidate: revalidate === false ? 31536000 : revalidate }, setContext], context);
      // A mutation in any local worker can revoke the native lease while the
      // asynchronous backend write is finishing. Remove a possibly old entry.
      if (revision !== record.revision || (lease && !await lease.valid())) await invoke(handler, 'set', [key, null, setContext], context);
    }
    catch { signal?.throwIfAborted(); }
  };
  const work = (async () => {
    try {
      lease = await cache.acquireExternalCacheLease(key, signal);
      if (lease) {
        // Even an immediately granted lease may follow a producer that finished
        // between our first backend read and this native admission.
        let shared;
        try {
          const latest = await invoke(handler, 'get', [key, getContext], context);
          if (latest?.value?.kind === 'FETCH' && fresh(latest, revalidate)) {
            shared = incremental.decode(latest.value);
            if (!Buffer.isBuffer(shared) || shared.length > MAX_BYTES) shared = undefined;
          }
        } catch { signal?.throwIfAborted(); }
        if (shared) { await cleanup(); return shared; }
      }
      const result = await wait(Promise.resolve().then(() => producer({ background, signal })), signal, 25_000);
      if (result?.[cache.DEFERRED_VALUE]) {
        const fill = (async () => {
          try { await store(await wait(result.cacheValue, signal, 25_000)); }
          finally { try { if (background) await wait(result.dispose?.(), signal, 1000); } finally { await cleanup(); } }
        })();
        const observed = fill.catch(() => {});
        state.pending.add(observed); void observed.finally(() => state.pending.delete(observed));
        return result.value;
      }
      try { await store(result); return result; } finally { await cleanup(); }
    } catch (error) { await cleanup(); throw error; }
  })();
  if (!background) return work;
  const observed = work.catch(async error => { try { await error?.dispose?.(); } catch {} });
  state.pending.add(observed); void observed.finally(() => state.pending.delete(observed));
  return bytes;
}
module.exports = { configured, load, invoke, wait, getEntry, setEntry, invalidate, cachedIncrementalValue };
