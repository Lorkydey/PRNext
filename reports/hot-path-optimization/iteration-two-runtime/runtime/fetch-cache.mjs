import { createHash } from 'node:crypto';
import cache from '../compat/data-cache.cjs';
import { dynamicUsage, trackStaticDependency } from '../compat/static-generation.cjs';
import { recordCacheDependency } from '../compat/use-cache.cjs';

const { cachedValue, deferredValue, optionalRequestContext, cacheState, getCachePaths,
  inCacheScope, nativeFetch, MAX_CACHE_VALUE_BYTES } = cache;
const PATCHED = Symbol.for('rustyx.fetch-cache');
const MAX_MEMO_ENTRIES = 128;
const MAX_MEMO_BYTES = 8 * 1024 * 1024;
const CAPTURE_IDLE_MS = 1000;
const CAPTURE_LIFETIME_MS = 20_000;
let registration;

class UncacheableResponse extends Error {
  constructor(response) { super('The fetch response is not cacheable'); this.response = response; }
  async dispose() { await this.response.body?.cancel().catch(() => {}); }
}

function responseMetadata(response) {
  return { version: 1, status: response.status, statusText: response.statusText,
    headers: [...response.headers], url: response.url, redirected: response.redirected,
    type: response.type, body: response.body !== null };
}

function decorate(response, metadata) {
  for (const name of ['url', 'redirected', 'type']) Object.defineProperty(response, name, { value: metadata[name], configurable: true });
  const clone = response.clone.bind(response);
  Object.defineProperty(response, 'clone', { value: () => decorate(clone(), metadata), configurable: true });
  return response;
}

function encodeResponse(metadata, chunks, length) {
  const header = Buffer.from(JSON.stringify(metadata));
  const value = Buffer.allocUnsafe(4 + header.byteLength + length);
  value.writeUInt32BE(header.byteLength);
  header.copy(value, 4);
  let offset = 4 + header.byteLength;
  for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
  return value;
}

function decodeResponse(value) {
  if (!Buffer.isBuffer(value) || value.byteLength < 4 || value.byteLength > MAX_CACHE_VALUE_BYTES) throw new Error('Invalid cached fetch response');
  const offset = 4 + value.readUInt32BE(0);
  if (offset > value.byteLength) throw new Error('Invalid cached fetch response');
  const metadata = JSON.parse(value.subarray(4, offset).toString());
  if (metadata.version !== 1 || !Array.isArray(metadata.headers) || !Number.isInteger(metadata.status) || metadata.status < 200 || metadata.status > 599) throw new Error('Invalid cached fetch response');
  return decorate(new Response(metadata.body ? value.subarray(offset) : null, metadata), metadata);
}

function incrementalCodec(url) {
  return { url,
    encode(value) {
      const offset = 4 + value.readUInt32BE(0);
      const info = JSON.parse(value.subarray(4, offset).toString());
      return { headers: Object.fromEntries(info.headers), status: info.status, url: info.url,
        body: value.subarray(offset).toString('base64'), _rustyx: { statusText: info.statusText, redirected: info.redirected, type: info.type, body: info.body } };
    },
    decode(entry) {
      const data = entry.data;
      if (!data || typeof data.body !== 'string' || data.body.length > Math.ceil(MAX_CACHE_VALUE_BYTES / 3) * 4 || data.status !== 200 || !data.headers || typeof data.headers !== 'object') throw new Error('Invalid incremental cached fetch');
      const bytes = Buffer.from(data.body, 'base64');
      const headers = new Headers(data.headers);
      if (headers.has('set-cookie')) throw new Error('Incremental cached fetch contains a session mutation');
      const info = { version: 1, status: data.status, statusText: data._rustyx?.statusText || '', headers: [...headers],
        url: typeof data.url === 'string' ? data.url : url, redirected: !!data._rustyx?.redirected,
        type: data._rustyx?.type || 'basic', body: data._rustyx?.body !== false };
      if (bytes.length + 4 + Buffer.byteLength(JSON.stringify(info)) > MAX_CACHE_VALUE_BYTES) throw new Error('Incremental cached fetch exceeds 2 MiB');
      return encodeResponse(info, [bytes], bytes.length);
    },
  };
}

// The origin is read once. The caller receives headers immediately; a bounded
// prefix is pumped ahead so small responses can fill the cache even if ignored.
// Once capture stops, only demand from that caller pulls further origin bytes.
function captureResponse(response, { signal, background = false } = {}) {
  const metadata = responseMetadata(response);
  const budget = MAX_CACHE_VALUE_BYTES - 4 - Buffer.byteLength(JSON.stringify(metadata));
  const contentLength = Number(response.headers.get('content-length'));
  if (budget < 0 || (Number.isFinite(contentLength) && contentLength > budget)) throw new UncacheableResponse(response);
  if (!response.body) return { response, value: Promise.resolve(encodeResponse(metadata, [], 0)) };
  const reader = response.body.getReader();
  let capture = [];
  let length = 0;
  let collecting = true;
  let stopped = false;
  let ended = false;
  let failure;
  let pumping = false;
  let waiting;
  const queued = [];
  let resolveValue;
  let rejectValue;
  const value = new Promise((resolve, reject) => { resolveValue = resolve; rejectValue = reject; });
  // A body can fail after its headers have already been returned to the caller.
  value.catch(() => {});
  let idle;
  const lifetime = setTimeout(() => finish(null), CAPTURE_LIFETIME_MS);
  lifetime.unref();
  const onAbort = () => finish(null);
  function finish(result, error) {
    if (!collecting) return;
    collecting = false; capture = [];
    clearTimeout(idle); clearTimeout(lifetime);
    signal?.removeEventListener('abort', onAbort);
    if (error) rejectValue(error); else resolveValue(result);
    if (background) {
      stopped = true; queued.length = 0;
      void reader.cancel(error).catch(() => {});
    }
  }
  function armIdle() {
    clearTimeout(idle);
    if (collecting) { idle = setTimeout(() => finish(null), CAPTURE_IDLE_MS); idle.unref(); }
  }
  function flushWaiter() {
    if (!waiting) return;
    const { controller, resolve } = waiting;
    if (queued.length) { controller.enqueue(queued.shift()); waiting = undefined; resolve(); }
    else if (failure) { controller.error(failure); waiting = undefined; resolve(); }
    else if (ended || stopped) { controller.close(); waiting = undefined; resolve(); }
  }
  async function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (!stopped && !ended && (collecting || waiting)) {
        const next = await reader.read();
        if (stopped) break;
        if (next.done) {
          ended = true;
          if (collecting) finish(encodeResponse(metadata, capture, length));
          flushWaiter();
          break;
        }
        if (collecting) {
          length += next.value.byteLength;
          if (length > budget) finish(null);
          else {
            // The caller may mutate bytes returned by a body reader. Capture
            // owns a bounded copy, so such mutations cannot poison later hits.
            capture.push(Uint8Array.from(next.value)); armIdle();
          }
        }
        if (!stopped) queued.push(next.value);
        flushWaiter();
      }
    } catch (error) {
      failure = error; ended = true;
      finish(null, error);
      flushWaiter();
    } finally { pumping = false; }
  }
  const body = new ReadableStream({
    pull(controller) {
      return new Promise(resolve => {
        waiting = { controller, resolve };
        flushWaiter();
        if (waiting) void pump();
      });
    },
    async cancel(reason) {
      stopped = true; queued.length = 0;
      finish(null);
      flushWaiter();
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) finish(null);
  armIdle();
  void pump();
  return { response: decorate(new Response(body, metadata), metadata), value };
}

function validateFetchTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('fetch next.tags must be an array');
  const tags = [];
  let invalid = false;
  for (const tag of value) {
    if (typeof tag !== 'string' || tag.length > 256 || tags.length >= 128) { invalid = true; continue; }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (invalid) console.warn('[rustyx] Invalid fetch tags were ignored; use at most 128 strings of at most 256 characters.');
  return tags;
}

function fetchPolicy(input, init, context) {
  const next = { ...input?.next, ...init?.next };
  const tags = validateFetchTags(next.tags);
  let revalidate = next.revalidate;
  let mode = init?.cache ?? (input instanceof Request ? input.cache : undefined);
  if (revalidate !== undefined && revalidate !== false &&
      (typeof revalidate !== 'number' || Number.isNaN(revalidate) || revalidate < 0)) throw new TypeError('fetch next.revalidate must be a nonnegative number or false');
  if ((mode === 'force-cache' && revalidate === 0) || (mode === 'no-store' && (revalidate === false || revalidate > 0))) {
    if (!context.production) console.warn('[rustyx] Conflicting fetch cache and next.revalidate options were ignored.');
    mode = undefined; revalidate = undefined;
  }
  if (mode === 'default') mode = undefined;
  const configured = context.cacheConfig?.forceNoStore ? 'force-no-store' : context.cacheConfig?.fetchCache || 'auto';
  if (!['auto', 'default-cache', 'only-cache', 'force-cache', 'default-no-store', 'only-no-store', 'force-no-store'].includes(configured)) throw new TypeError('Invalid route fetchCache setting');
  const uncached = mode === 'no-store' || mode === 'no-cache' || revalidate === 0;
  const explicitCache = mode === 'force-cache' || revalidate === false || revalidate > 0;
  if (configured === 'only-cache' && uncached) throw new Error('fetchCache: only-cache forbids uncached fetches');
  if (configured === 'only-no-store' && explicitCache) throw new Error('fetchCache: only-no-store forbids cached fetches');
  if (configured === 'force-no-store') { mode = 'no-store'; revalidate = 0; }
  else if (configured === 'force-cache') { mode = 'force-cache'; if (revalidate === 0) revalidate = undefined; }
  else if (!mode && revalidate === undefined) {
    if (configured === 'default-no-store' || configured === 'only-no-store' || cacheState(context)?.noStore) mode = 'no-store';
    else if (configured === 'default-cache' || configured === 'only-cache' || context.cacheConfig?.dynamic === 'error') mode = 'force-cache';
  }
  if (mode === 'no-store' || mode === 'no-cache' || revalidate === 0) dynamicUsage('an uncached fetch', context);
  const persist = mode !== 'no-store' && mode !== 'no-cache' && revalidate !== 0 &&
    (mode === 'force-cache' || revalidate === false || revalidate > 0);
  if (!persist && context.cacheComponents && !inCacheScope()) dynamicUsage('an uncached fetch', context);
  return { persist, tags, revalidate: revalidate === false || revalidate === Infinity || revalidate === undefined ? null : revalidate,
    memoOptions: JSON.stringify([mode, revalidate, tags]) };
}

async function prepareRequest(input, init) {
  // Opaque streaming request bodies cannot be hashed before dispatch without
  // consuming/teeing the upload. They retain native streaming and bypass cache.
  if (init?.body instanceof ReadableStream || (input instanceof Request && input.body && init?.body === undefined)) return null;
  const known = init?.body;
  if ((typeof known === 'string' && Buffer.byteLength(known) > MAX_CACHE_VALUE_BYTES) ||
      (known instanceof Blob && known.size > MAX_CACHE_VALUE_BYTES) ||
      (ArrayBuffer.isView(known) && known.byteLength > MAX_CACHE_VALUE_BYTES) ||
      (known instanceof ArrayBuffer && known.byteLength > MAX_CACHE_VALUE_BYTES)) return null;
  const form = known instanceof FormData ? [] : null;
  if (form) {
    let size = 0;
    for (const [name, value] of known) {
      size += Buffer.byteLength(name) + 128 + (typeof value === 'string' ? Buffer.byteLength(value) : value.size + Buffer.byteLength(value.name) + Buffer.byteLength(value.type));
      if (size > MAX_CACHE_VALUE_BYTES) return null;
      form.push([name, value]);
    }
  }
  const request = new Request(input, init);
  const headers = [...request.headers];
  const explicitHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (form && !explicitHeaders.has('content-type')) {
    // FormData gets a new random wire boundary per Request. Match its ordered
    // fields and file bytes, while retaining any caller-supplied content type.
    const contentType = headers.find(header => header[0] === 'content-type');
    if (contentType) contentType[1] = 'multipart/form-data';
  }
  const fields = [request.url, request.method, headers, request.mode, request.credentials,
    request.redirect, request.referrer, request.referrerPolicy, request.integrity, request.keepalive, request.cache, request.duplex];
  const metadata = JSON.stringify(fields);
  if (Buffer.byteLength(metadata) > 64 * 1024) return null;
  const hash = createHash('sha256').update('rustyx-fetch-v1\0').update(metadata).update('\0');
  if (!request.body) return { request, key: hash.digest('hex') };
  if (form) {
    hash.update('form-data\0');
    for (const [name, value] of form) {
      if (typeof value === 'string') hash.update(JSON.stringify([name, 'text', value]) + '\0');
      else {
        hash.update(JSON.stringify([name, 'file', value.name, value.type, value.size]) + '\0');
        hash.update(new Uint8Array(await value.arrayBuffer())).update('\0');
      }
    }
    return { request, key: hash.digest('hex') };
  }
  const chunks = [];
  const reader = request.body.getReader();
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value); length += next.value.byteLength;
    if (length > MAX_CACHE_VALUE_BYTES) {
      // This is a known BodyInit (e.g. FormData), so the untouched caller input
      // can still be sent normally after cancelling this temporary encoding.
      await reader.cancel();
      return null;
    }
  }
  const bytes = Buffer.concat(chunks, length);
  hash.update(bytes);
  return { request: new Request(request, { body: bytes, duplex: 'half' }), key: hash.digest('hex') };
}

function memoState(state) {
  return state.fetchMemo ||= { entries: new Map(), bytes: 0 };
}

export function installFetchCache() {
  let dispatcher = globalThis.fetch[PATCHED];
  if (!dispatcher) {
    dispatcher = { handlers: [] };
    const fetch = function fetch(input, init) {
      for (let index = dispatcher.handlers.length - 1; index >= 0; index--) {
        const handler = dispatcher.handlers[index];
        const context = handler.context();
        if (context) return handler.fetch(input, init, context);
      }
      return nativeFetch(input, init);
    };
    Object.defineProperty(fetch, PATCHED, { value: dispatcher });
    globalThis.fetch = fetch;
  }
  if (registration && dispatcher.handlers.includes(registration)) return globalThis.fetch;
  async function fetch(input, init, context) {
    if (context.phase === 'pages' || init?.next?.internal) return nativeFetch(input, init);
    if (inCacheScope()) {
      const next = init?.next || input?.next || {};
      if (next.revalidate !== undefined && next.revalidate !== false && (typeof next.revalidate !== 'number' || Number.isNaN(next.revalidate) || next.revalidate < 0)) throw new TypeError('fetch next.revalidate must be a nonnegative number or false');
      recordCacheDependency(next);
      return nativeFetch(input, init);
    }
    const policy = fetchPolicy(input, init, context);
    trackStaticDependency({ tags: policy.tags, paths: getCachePaths(context),
      revalidate: context.cacheConfig?.dynamic === 'force-static' && policy.revalidate === 0 ? null : policy.revalidate }, context);
    if (init?.dispatcher || init?.agent) return nativeFetch(input, init);
    const state = cacheState(context);
    const explicitSignal = init?.signal !== undefined || input instanceof Request;
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const memoize = context.phase === 'render' && method === 'GET' && !explicitSignal;
    const hardRefresh = !context.production && /(?:^|,)\s*no-cache\s*(?:,|$)/i.test(context.headers?.get?.('cache-control') || '');
    const persist = policy.persist && !hardRefresh && !context.draftMode && !context.cacheConfig?.forceNoStore;
    if (!persist && !memoize) return nativeFetch(input, init);
    const prepared = await prepareRequest(input, init);
    if (!prepared) return nativeFetch(input, init);
    const request = prepared.request;
    request.signal.throwIfAborted();
    const memo = memoize ? memoState(state) : null;
    const memoKey = `${prepared.key}:${policy.memoOptions}`;
    await state.invalidations;
    if (memo?.entries.has(memoKey)) {
      const entry = memo.entries.get(memoKey);
      const value = await entry.promise;
      if (value) return decodeResponse(value);
      // A live/noncacheable Response always belongs to one caller. A follower
      // that cannot reuse completed bytes makes its own native request.
    }
    let entry;
    if (memo && memo.entries.size < MAX_MEMO_ENTRIES && memo.bytes + MAX_CACHE_VALUE_BYTES <= MAX_MEMO_BYTES) {
      let resolve;
      entry = { size: MAX_CACHE_VALUE_BYTES, promise: new Promise(done => { resolve = done; }), resolve };
      memo.entries.set(memoKey, entry); memo.bytes += entry.size;
    }
    function settleMemo(value) {
      if (!entry) return;
      memo.bytes -= entry.size;
      if (value) { entry.size = value.byteLength; memo.bytes += entry.size; }
      else if (memo.entries.get(memoKey) === entry) memo.entries.delete(memoKey);
      entry.resolve(value);
      entry = undefined;
    }
    const producer = async ({ background = false, signal, cache: canPersist = true } = {}) => {
      const response = await nativeFetch(request, background && signal ? { signal: AbortSignal.any([request.signal, signal]) } : undefined);
      // Set-Cookie responses must not replay a session mutation, even when the
      // request itself explicitly opted into shared caching.
      if (response.headers.has('set-cookie') || (persist && response.status !== 200) || (!canPersist && !entry)) throw new UncacheableResponse(response);
      const captured = captureResponse(response, { signal, background });
      captured.value.then(settleMemo, () => settleMemo(null));
      return deferredValue(captured.response, captured.value, () => captured.response.body?.cancel());
    };
    try {
      const result = persist ? await cachedValue(prepared.key, producer, {
        tags: policy.tags, paths: getCachePaths(context), revalidate: policy.revalidate,
        context, signal: request.signal, incremental: incrementalCodec(request.url),
      }) : await producer({ cache: false });
      if (Buffer.isBuffer(result)) { settleMemo(result); return decodeResponse(result); }
      // Without persistent caching, we unwrap our own deferred value here.
      if (!persist) return result.value;
      return result;
    } catch (error) {
      settleMemo(null);
      if (error instanceof UncacheableResponse) return error.response;
      throw error;
    }
  }
  registration = { context: optionalRequestContext, fetch };
  dispatcher.handlers.push(registration);
  return globalThis.fetch;
}
