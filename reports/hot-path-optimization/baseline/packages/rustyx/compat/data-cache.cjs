'use strict';
const { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { trackStaticDependency } = require('./static-generation.cjs');

// Capture before the runtime installs its application-facing fetch wrapper.
const nativeFetchSymbol = Symbol.for('rustyx.nativeFetch');
const nativeFetch = globalThis[nativeFetchSymbol] ||= globalThis.fetch.bind(globalThis);
const cacheStorage = new AsyncLocalStorage();
const owners = new Map();
const MAX_CACHE_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_OWNERS = 1024;
const WAIT_TIMEOUT_MS = 25_000;
const DEFERRED_VALUE = Symbol('Rustyx deferred cache value');
// Cache RPC is a local JSON protocol, not an application fetch. Keep its socket
// pool small and outside request AsyncLocalStorage stores.
const rpcScope = new AsyncResource('rustyx-cache-transport');
// Keep the bounded active pool reusable across bursts: trimming it to four
// idle sockets churns ephemeral ports under concurrent PPR traffic. Idle
// connections expire after 30 seconds and retain no request context.
const rpcAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxTotalSockets: 32, maxFreeSockets: 32, timeout: 30_000 });
function localRpc(target, body, signal) {
  return rpcScope.runInAsyncScope(() => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const request = http.request(target.url, { method: 'POST', agent: rpcAgent,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}`, 'content-length': Buffer.byteLength(body) },
    }, response => {
      let size = 0;
      const chunks = [];
      response.on('error', error => finish(error));
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) request.destroy(new Error('Cache RPC response exceeds 4 MiB'));
        else if (response.statusCode >= 200 && response.statusCode < 300) chunks.push(chunk);
      });
      response.on('end', () => {
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        try { finish(null, { ok, status: response.statusCode, value: ok ? JSON.parse(Buffer.concat(chunks, size).toString()) : undefined }); }
        catch (error) { finish(error); }
      });
    });
    const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error('Cache RPC aborted'));
    request.on('error', error => finish(error));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else request.end(body);
  }));
}

function createCacheState() {
  return { pending: new Set(), invalidations: Promise.resolve(), noStore: false, refresh: false };
}
function optionalRequestContext() {
  // Lazy access avoids a cycle when headers.cjs imports the scope guard.
  try { return require('./headers.cjs').currentRequest(); } catch { return undefined; }
}
function cacheState(context = optionalRequestContext()) {
  if (!context) return undefined;
  return context.cacheState ||= createCacheState();
}
function inCacheScope() { return Boolean(cacheStorage.getStore()); }
function currentCacheScope() { return cacheStorage.getStore(); }
function runCacheScope(callback, scope = true) { return cacheStorage.run(scope, callback); }

function validateTags(tags = []) {
  if (!Array.isArray(tags) || tags.length > 128) throw new TypeError('Cache tags must be an array with at most 128 entries');
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.length > 256) throw new TypeError('Cache tags must be strings of at most 256 characters');
  }
  return [...new Set(tags)];
}
function validateRevalidate(value, { allowZero = false } = {}) {
  if (value === undefined || value === false || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`Cache revalidate must be ${allowZero ? 'a nonnegative' : 'a positive'} number of seconds or false`);
  }
  return value;
}

function normalizeCachePath(value, { groups = false } = {}) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new TypeError('Cache paths must be absolute application paths');
  }
  if (value.length > 1024) throw new TypeError('Cache paths must not exceed 1024 characters');
  if (groups) value = value.split('/').filter(segment => !/^\([^/]+\)$/.test(segment)).join('/') || '/';
  const pathname = new URL(value, 'http://rustyx.local').pathname
    .replace(/%[0-9a-f]{2}/gi, escape => {
      const character = String.fromCharCode(parseInt(escape.slice(1), 16));
      return /[a-z\d_.~-]/i.test(character) ? character : escape.toUpperCase();
    });
  return pathname.replace(/\/+$/, '') || '/';
}
function getCachePaths(context = optionalRequestContext()) {
  if (!context) return [];
  const paths = new Set();
  const add = pathname => {
    paths.add(`page:${pathname}`);
    paths.add('layout:/');
    const segments = pathname.split('/').filter(Boolean);
    for (let index = 1; index <= segments.length; index++) paths.add(`layout:/${segments.slice(0, index).join('/')}`);
  };
  if (context.url) add(normalizeCachePath(new URL(context.url, 'http://rustyx.local').pathname));
  else if (context.pathname) add(normalizeCachePath(context.pathname));
  const pattern = context.route?.pattern || context.routePattern;
  if (pattern) add(normalizeCachePath(pattern, { groups: true }));
  return [...paths];
}

function endpoint() {
  const url = process.env.RUSTYX_CACHE_URL;
  const token = process.env.RUSTYX_CACHE_TOKEN;
  return url && token ? { url, token } : undefined;
}
async function cacheGeneration(signal) {
  const target = endpoint();
  if (!target) return null;
  const result = await rpc(target, { op: 'generation' }, signal);
  if (!Number.isSafeInteger(result.generation) || result.generation < 0) throw new Error('Invalid Rustyx cache generation');
  return result.generation;
}

/** Coordinate external backend fills across local Node workers without storing a second value. */
async function acquireExternalCacheLease(key, signal) {
  const target = endpoint();
  if (!target) return undefined;
  const digest = require('node:crypto').createHash('sha256').update('rustyx-external-lease\0').update(key).digest('hex');
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let waited = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    let entry;
    try { entry = await rpc(target, { op: 'read', key: digest, tags: [], paths: [], revalidate: null, forceFresh: true }, signal); }
    catch { throwIfAborted(signal); return undefined; }
    if (entry.state === 'miss' && entry.lease) return { waited, release: () => release(target, digest, entry.lease),
      valid: async () => { try { return (await rpc(target, { op: 'leaseStatus', key: digest, lease: entry.lease }, signal)).valid === true; } catch { return false; } },
    };
    if (entry.state !== 'pending') return undefined;
    waited = true;
    await delay(Math.min(Math.max(Number(entry.retryAfterMs) || 20, 5), 100), undefined, { signal });
  }
  throw new Error('Timed out waiting for a native incremental cache lease');
}
async function rpc(target, operation, signal) {
  const body = JSON.stringify(operation);
  const url = new URL(target.url);
  const local = url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 5000);
  timer.unref();
  try {
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let retryMs = 10;
    while (true) {
      const response = local ? await localRpc(target, body, operationSignal) : await nativeFetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
        body,
        signal: operationSignal,
      });
      // The deadline covers the JSON body as well as response headers. A
      // completed RPC must release its timer and inherited request context.
      if (response.ok) return local ? response.value : await response.json();
      await response.body?.cancel();
      // The native service bounds admission before doing any operation. Retry
      // temporary saturation instead of turning a burst of misses into origin work.
      if (response.status !== 503) throw new Error(`Rustyx data cache ${operation.op} failed (${response.status})`);
      await delay(retryMs + Math.floor(Math.random() * 10), undefined, { signal: operationSignal });
      retryMs = Math.min(retryMs * 2, 200);
    }
  } finally {
    clearTimeout(timer);
  }
}
function throwIfAborted(signal) { signal?.throwIfAborted(); }
function deferredValue(value, cacheValue, dispose) {
  return { [DEFERRED_VALUE]: true, value, cacheValue: Promise.resolve(cacheValue), dispose };
}
function untilAborted(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function bufferValue(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new TypeError('Cache producers must return bytes');
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
function decodeValue(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_CACHE_VALUE_BYTES / 3) * 4) throw new Error('Invalid Rustyx data cache value');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_CACHE_VALUE_BYTES) throw new Error('Invalid Rustyx data cache value');
  return bytes;
}

async function release(target, key, lease) {
  try { await rpc(target, { op: 'release', key, lease }, AbortSignal.timeout(1000)); } catch { /* A native lease expires even if its owner disappears. */ }
}
function trackBackground(state, work) {
  const pending = work.catch(async error => {
    // Fetch may use a thrown sentinel to return an uncacheable live Response.
    // Background refresh has no consumer, so release that response body too.
    try { await untilAborted(error?.dispose?.(), AbortSignal.timeout(1000)); } catch { /* Preserve the previous cached value. */ }
  });
  if (state) {
    state.pending.add(pending);
    void pending.finally(() => state.pending.delete(pending));
  }
}

async function compute(target, key, lease, producer, options) {
  const identity = `${target.url}\n${key}`;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error('Rustyx data cache producer timed out')), Math.max(1, options.deadline - Date.now()));
  timer.unref();
  let completed;
  const completion = new Promise(resolve => { completed = resolve; });
  if (owners.size < MAX_PENDING_OWNERS) owners.set(identity, completion);
  const finish = () => {
    clearTimeout(timer);
    if (owners.get(identity) === completion) owners.delete(identity);
    completed();
  };
  const store = async value => {
    try {
      throwIfAborted(signal);
      if (value === null) { await release(target, key, lease); return; }
      const bytes = bufferValue(value);
      if (bytes.length > MAX_CACHE_VALUE_BYTES) {
        await release(target, key, lease);
        return;
      }
      // A failed or superseded commit never replays the producer (which may
      // perform an explicitly cached POST). Return the successful origin value.
      try {
        const metadata = options.resolveMetadata?.();
        if (metadata?.externalCache) { await release(target, key, lease); return; }
        const result = await rpc(target, { op: 'commit', key, lease, value: bytes.toString('base64'), revalidate: options.revalidate,
          ...(metadata ? { tags: validateTags(metadata.tags), paths: metadata.paths || [], revalidate: validateRevalidate(metadata.revalidate, { allowZero: true }), expire: metadata.expire } : {}) }, signal);
        if (!result.stored) await release(target, key, lease);
      } catch {
        await release(target, key, lease);
        throwIfAborted(signal);
      }
    } catch (error) {
      await release(target, key, lease);
      throw error;
    }
  };
  try {
    throwIfAborted(signal);
    const result = await untilAborted(Promise.resolve().then(() => producer({ background: Boolean(options.background), signal })), signal);
    if (result?.[DEFERRED_VALUE]) {
      const fill = (async () => {
        try { await store(await untilAborted(result.cacheValue, signal)); }
        catch (error) {
          await release(target, key, lease);
          throw error;
        } finally {
          if (options.background) { try { await untilAborted(result.dispose?.(), signal); } catch {} }
          finish();
        }
      })();
      trackBackground(options.state, fill);
      return result.value;
    }
    const bytes = bufferValue(result);
    await store(bytes);
    finish();
    return bytes;
  } catch (error) {
    await release(target, key, lease);
    finish();
    throw error;
  }
}

async function uncachedValue(producer, state, signal) {
  const result = await producer({ background: false, signal, cache: false });
  if (result?.[DEFERRED_VALUE]) {
    // A fetch may already have started its bounded capture before discovering
    // there is no cache service. Observe it without retaining the live response.
    trackBackground(state, untilAborted(result.cacheValue, AbortSignal.timeout(WAIT_TIMEOUT_MS)));
    return result.value;
  }
  return bufferValue(result);
}

async function cachedValue(key, producer, options = {}) {
  if (typeof key !== 'string' || !/^[a-f\d]{64}$/.test(key)) throw new TypeError('Cache keys must be a SHA-256 hex digest');
  const context = options.context || optionalRequestContext();
  const state = cacheState(context);
  const tags = validateTags(options.tags);
  const paths = options.paths || getCachePaths(context);
  const revalidate = validateRevalidate(options.revalidate);
  trackStaticDependency({ tags, paths, revalidate }, context);
  const signal = options.signal;
  if (state) await state.invalidations;
  throwIfAborted(signal);
  if (options.incremental && (context?.cacheHandler || context?.manifest?.config?.cacheHandler)) {
    return require('./incremental-cache.cjs').cachedIncrementalValue(key, producer, { ...options, context, tags, paths, revalidate });
  }
  const target = endpoint();
  // Builds and standalone runtime use have no native cache server. Compute
  // without claiming persistence; production workers always receive its URL.
  if (!target) return uncachedValue(producer, state, signal);
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (true) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) throw new Error('Timed out waiting for a Rustyx data cache lease');
    let entry;
    try { entry = await rpc(target, { op: 'read', key, tags, paths, revalidate, forceFresh: Boolean(options.forceFresh || context?.staticState), ...(options.versioned ? { versioned: true } : {}) }, signal); }
    catch (error) {
      throwIfAborted(signal);
      // A temporarily unavailable cache must not make an origin unavailable.
      return uncachedValue(producer, state, signal);
    }
    if (options.versioned && (typeof entry.key !== 'string' || !/^[a-f\d]{64}$/.test(entry.key) || !Number.isSafeInteger(entry.generation) || entry.generation < 0)) throw new Error('Invalid Rustyx versioned cache response');
    const entryKey = options.versioned ? entry.key : key;
    const produce = options.versioned ? info => producer({ ...info, generation: entry.generation }) : producer;
    if (entry.state === 'fresh') return decodeValue(entry.value);
    if (entry.state === 'stale') {
      const bytes = decodeValue(entry.value);
      if (entry.lease) {
        if (owners.size >= MAX_PENDING_OWNERS) trackBackground(state, release(target, entryKey, entry.lease));
        else trackBackground(state, compute(target, entryKey, entry.lease, produce, { revalidate, signal, state, background: true, deadline, resolveMetadata: options.resolveMetadata }));
      }
      return bytes;
    }
    if (entry.state === 'miss' && entry.lease) {
      if (owners.size >= MAX_PENDING_OWNERS) { await release(target, entryKey, entry.lease); return uncachedValue(producer, state, signal); }
      return compute(target, entryKey, entry.lease, produce, { revalidate, signal, state, deadline, resolveMetadata: options.resolveMetadata });
    }
    if (entry.state !== 'pending') throw new Error('Invalid Rustyx data cache lease response');
    const waitMs = Math.min(Math.max(Number(entry.retryAfterMs) || 20, 5), 100, deadline - Date.now());
    const owner = owners.get(`${target.url}\n${entryKey}`);
    if (owner) {
      // Wait for local work, then read again so tags/path attachments and
      // invalidation revisions are checked. Never share an uncacheable Response.
      await Promise.race([owner.catch(() => {}), delay(waitMs, undefined, { signal })]);
    } else await delay(waitMs, undefined, { signal });
  }
}

function queueInvalidation(context, operation) {
  const state = cacheState(context);
  const target = endpoint();
  const custom = Object.keys(context.cacheHandlers || context.manifest?.config?.cacheHandlers || {}).length > 0;
  const incremental = context.cacheHandler || context.manifest?.config?.cacheHandler;
  if (!target && !custom && !incremental) throw new Error('Cache invalidation requires a running Rustyx server');
  state.refresh = true;
  state.invalidations = state.invalidations.then(async () => {
    if (target) await rpc(target, { op: 'invalidate', ...operation });
    if (custom) await require('./cache-handlers.cjs').invalidateHandlers(context, operation);
    if (incremental) await require('./incremental-cache.cjs').invalidate(context, operation);
  });
  // Public invalidation functions return void. Retain errors for the next read
  // or runtime flush without producing an unhandled rejection in the meantime.
  void state.invalidations.catch(() => {});
}
async function flushCacheWork(context = optionalRequestContext()) {
  const state = cacheState(context);
  if (!state) return;
  await state.invalidations;
  while (state.pending.size) await Promise.all([...state.pending]);
  await state.invalidations;
}
async function flushCacheInvalidations(context = optionalRequestContext()) {
  const state = cacheState(context);
  if (state) await state.invalidations;
}

module.exports = {
  cacheGeneration, acquireExternalCacheLease, DEFERRED_VALUE,
  MAX_CACHE_VALUE_BYTES, nativeFetch, cachedValue, deferredValue, createCacheState, cacheState,
  flushCacheWork, flushCacheInvalidations, runCacheScope, inCacheScope, currentCacheScope, optionalRequestContext,
  getCachePaths, normalizeCachePath, validateTags, validateRevalidate, queueInvalidation,
};
