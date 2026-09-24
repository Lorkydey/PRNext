import { PassThrough } from 'node:stream';
import { trackRequestWork } from './request-work.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { NextRequest } from '../compat/server.cjs';
import { removeBasePath } from '../compat/paths.cjs';
import { proxyRouteRequest } from '../compat/route-request.cjs';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { flushCacheInvalidations } from '../compat/data-cache.cjs';
import { navigationResponse } from './navigation.mjs';
import { abortError, apiTimeoutError, STREAM_CHUNK_BYTES, streamingBody, withSignal } from './stream-utils.mjs';
import { withCacheRequest } from './cache-request.mjs';
import { installFetchCache } from './fetch-cache.mjs';
import { staticPath } from './pages-paths.mjs';
import { collectStaticParams } from './app-static-params.mjs';
import { loadModule } from './module-loader.mjs';
import { CapturedResponse, createRequest, queryFromUrl, MAX_RESPONSE_BYTES, forbiddenHeaders } from './http.mjs';

installFetchCache();

class StreamingResponse extends CapturedResponse {
  constructor() {
    super({ highWaterMark: STREAM_CHUNK_BYTES }, true);
    this.head = new Promise((resolve, reject) => { this._resolveHead = resolve; this._rejectHead = reject; });
    // Headers can fail synchronously in a handler before runApi awaits them.
    this.head.catch(() => {});
  }
  get output() {
    if (!this._output) {
      this._output = new PassThrough({ highWaterMark: STREAM_CHUNK_BYTES });
      this._output.on('error', () => {});
    }
    return this._output;
  }
  _commit() {
    if (this._committed) return;
    if (!Number.isInteger(this.statusCode) || this.statusCode < 100 || this.statusCode > 599) throw new Error('Invalid response status');
    this._committed = true;
    this.headersSent = true;
    const headers = Object.fromEntries(Object.entries(this._headers).filter(([name]) => !forbiddenHeaders.has(name) && name !== 'content-length').map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]));
    this._resolveHead({ status: this.statusCode, headers });
  }
  _write(chunk, _encoding, callback) {
    try { this._commit(); } catch (error) { callback(error); return; }
    if (this._compact) {
      // Own the bytes before acknowledging the producer's reusable buffer.
      this._compactBody = Buffer.from(chunk);
      callback();
      return;
    }
    let offset = 0;
    const writeNext = error => {
      if (error) { callback(error); return; }
      if (offset >= chunk.byteLength) { callback(); return; }
      // Node permits reusing a write buffer after its callback. PassThrough can
      // acknowledge before its reader consumes these bytes, so retain an owned
      // copy of each bounded part rather than an alias to the user's buffer.
      const part = Buffer.from(chunk.subarray(offset, Math.min(offset + STREAM_CHUNK_BYTES, chunk.byteLength)));
      offset += part.byteLength;
      this.output.write(part, writeNext);
    };
    writeNext();
  }
  _final(callback) {
    try { this._commit(); } catch (error) { callback(error); return; }
    if (this._compact) { this._compactComplete = true; callback(); return; }
    this.output.end(callback);
  }
  _destroy(error, callback) {
    if (!this._committed) this._rejectHead(error || new Error('API response closed before sending headers'));
    // Writable's normal autoDestroy happens at finish while unread response
    // bytes may still be in the readable side. Keep those bytes available.
    if (error || !this.writableFinished) this.output.destroy(error);
    callback(error);
  }
  writeHead(...args) { super.writeHead(...args); this._commit(); return this; }
  flushHeaders() { this._commit(); }
  end(chunk, encoding, callback) {
    // Only a single terminal write qualifies. Explicit flush/writeHead/write
    // always keeps progressive delivery and backpressure, regardless of size.
    if (!this.headersSent && !this._output && !this.writableEnded &&
        (chunk == null || typeof chunk === 'function' || typeof chunk === 'string' || chunk instanceof Uint8Array)) {
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk?.byteLength || 0;
      this._compact = size <= 16 * 1024;
    }
    this._commit();
    return super.end(chunk, encoding, callback);
  }
}

function abortIncomingRequest(request, error) {
  request.on('error', () => {});
  request.socket?.on('error', () => {});
  if (request.destroyed || (request.readableEnded && request.complete)) {
    if (!request.aborted) { request.aborted = true; request.emit('aborted'); }
  }
  request.destroy(error);
}

function requestAbortController(signal) {
  const controller = new AbortController();
  const aborted = () => controller.abort(abortError(signal.reason));
  if (signal?.aborted) aborted();
  else signal?.addEventListener('abort', aborted, { once: true });
  return { controller, cleanup: () => signal?.removeEventListener('abort', aborted) };
}

async function runStreamingPagesApi(handler, request, { method, signal, timeoutMs }) {
  const response = new StreamingResponse();
  const { controller, cleanup } = requestAbortController(signal);
  response._revalidateSignal = controller.signal;
  let canceled = false;
  const cancelRequest = error => {
    if (canceled) return;
    canceled = true;
    controller.abort(error);
    response.destroy(error);
    abortIncomingRequest(request, error);
  };
  const aborted = () => cancelRequest(abortError(controller.signal.reason));
  controller.signal.addEventListener('abort', aborted, { once: true });
  const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted); cleanup(); };
  const timer = setTimeout(() => cancelRequest(apiTimeoutError('response headers', timeoutMs)), timeoutMs);
  timer.unref();
  if (controller.signal.aborted) cancelRequest(abortError(controller.signal.reason));
  else trackRequestWork(Promise.resolve().then(() => handler(request, response)), signal).then(result => {
    if (result !== undefined && result !== response && !response.writableEnded) {
      throw new Error('Pages API handlers must send their response with res.send(), res.json(), or res.end()');
    }
  }).catch(error => response.destroy(error));
  try {
    const head = await response.head;
    clearTimeout(timer);
    if (response._compactComplete) {
      if (response.errored) throw response.errored;
      // The body is already complete. The transport can send head/body/end in
      // one writev without consuming an async iterator or a PassThrough.
      finish();
      const body = method === 'HEAD' || [204, 205, 304].includes(head.status)
        ? Buffer.alloc(0) : response._compactBody || Buffer.alloc(0);
      response._compactBody = undefined;
      return { ...head, bufferedBody: body,
        body: method === 'HEAD' || [204, 205, 304].includes(head.status)
          ? body : (async function* () { if (body.length) yield body; })(), cancel: () => {} };
    }
    const body = streamingBody(response.output, { signal: controller.signal, timeoutMs, onCancel: cancelRequest, onComplete: finish });
    const cancel = reason => body.cancel(reason);
    if (method === 'HEAD' || [204, 205, 304].includes(head.status)) {
      await cancel(abortError('HTTP response does not carry a body'));
      return { ...head, body: Buffer.alloc(0), cancel };
    }
    return { ...head, body, cancel };
  } catch (error) {
    cancelRequest(error);
    finish();
    throw error;
  }
}

function parseBody(bytes, contentType = '') {
  if (!bytes.length) return undefined;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    try { return JSON.parse(bytes.toString('utf8')); } catch { const error = new Error('Invalid JSON request body'); error.statusCode = 400; throw error; }
  }
  if (type === 'application/x-www-form-urlencoded') {
    return queryFromUrl(new URL(`http://localhost/?${bytes.toString('utf8')}`));
  }
  return bytes.toString('utf8');
}

export function runApi(options) {
  return withCacheRequest(options, options.route?.router === 'app' ? 'route' : 'pages', context => runApiInner(options, context));
}

async function runApiInner({ modulePath, route = {}, manifest = {}, production = process.env.NODE_ENV === 'production', url, originalUrl, params = {}, method = 'GET', headers = {}, body = '', stream = false, signal, timeoutMs = 25_000, preserveHeadBody = false }, cacheContext) {
  const mod = await withSignal(loadModule(modulePath), stream ? signal : undefined);
  const requestOriginal = originalUrl ? new URL(originalUrl, url) : undefined;
  if (requestOriginal) requestOriginal.pathname = removeBasePath(requestOriginal.pathname, manifest.config?.basePath || '');
  const { request, bytes } = createRequest({ url, originalUrl: requestOriginal?.href, params, method, headers, body });
  request.draftMode = cacheContext.draftMode;
  request.previewData = cacheContext.previewData;
  request.preview = cacheContext.previewData !== false;
  if (typeof mod.default !== 'function') {
    if (route.router === 'app' && manifest.dev) {
      const listing = await collectStaticParams({ page: mod, pageConfig: route.handlerConfig, segments: [] }, route.pattern);
      if (route.pattern?.includes('[') && route.cacheConfig?.dynamicParams === false) {
        const requested = staticPath(route.pattern, new URL(url).pathname).path;
        if (!listing.generated || !listing.params.some(params => staticPath(route.pattern, { params }).path === requested)) {
          return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Not Found') };
        }
      }
    }
    const handler = mod[method] || (method === 'HEAD' ? mod.GET : undefined);
    if (!handler) {
      const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].filter(verb => typeof mod[verb] === 'function');
      if (allowed.includes('GET') && !allowed.includes('HEAD')) allowed.push('HEAD');
      if (!allowed.includes('OPTIONS')) allowed.push('OPTIONS');
      return { status: method === 'OPTIONS' ? 204 : 405, headers: { allow: allowed.sort().join(', ') }, body: Buffer.alloc(0) };
    }
    const lifecycle = stream ? requestAbortController(signal) : null;
    if (lifecycle?.controller.signal.aborted) {
      lifecycle.cleanup();
      throw abortError(lifecycle.controller.signal.reason);
    }
    const init = { method, headers, ...(lifecycle ? { signal: lifecycle.controller.signal } : {}) };
    if (!['GET', 'HEAD'].includes(method) && bytes.length) init.body = bytes;
    const timeout = lifecycle && setTimeout(() => lifecycle.controller.abort(apiTimeoutError('response headers', timeoutMs)), timeoutMs);
    timeout?.unref();
    const pendingResponse = runRequestContext({ url, method, headers, params, production, cacheComponents: manifest.config?.cacheComponents, cacheLife: manifest.config?.cacheLife, cacheHandlers: manifest.config?.cacheHandlers, cacheHandler: manifest.config?.cacheHandler, cacheMaxMemorySize: manifest.config?.cacheMaxMemorySize, distDir: path.dirname(path.dirname(modulePath)), signal: lifecycle?.controller.signal || signal, previewModeId: manifest.previewModeId, basePath: manifest.config?.basePath || '', routePattern: route.pattern, cacheConfig: route.cacheConfig, phase: 'route', cacheState: cacheContext.cacheState, staticState: cacheContext.staticState, mutableCookies: true }, async () => {
      let result;
      try { result = await handler(proxyRouteRequest(new NextRequest(requestOriginal || url, init), currentRequest()), { params: Promise.resolve(params) }); }
      catch (error) {
        const navigation = navigationResponse(error);
        if (!navigation) throw error;
        result = new Response(navigation.body, { status: navigation.status, headers: navigation.headers });
      }
      const context = currentRequest();
      if (context.draftMode || context.draftChanged) cacheContext.draftChanged = true;
      try { await flushCacheInvalidations(context); }
      catch (error) {
        // The handler may already have opened a live origin stream. A failed
        // invalidation prevents returning its response, so cancel that body too.
        // Application cancellation callbacks must not hold the error response.
        if (result instanceof Response) void result.body?.cancel(error).catch(() => {});
        throw error;
      }
      const changedCookies = [...context.outgoingCookies.values()];
      if (stream) context.cookies._mutable = false;
      return { result, changedCookies, runInContext: stream ? AsyncLocalStorage.snapshot() : undefined };
    });
    if (lifecycle) pendingResponse.then(({ result }) => {
      if (lifecycle.controller.signal.aborted) result?.body?.cancel(lifecycle.controller.signal.reason).catch(() => {});
    }, () => {});
    trackRequestWork(pendingResponse, signal);
    let result, changedCookies, runInContext;
    try {
      ({ result, changedCookies, runInContext } = await withSignal(pendingResponse, lifecycle?.controller.signal));
      if (!(result instanceof Response)) throw new Error('Route handler must return a Response');
      if (result.headers.has('x-middleware-rewrite') || result.headers.get('x-middleware-next') === '1') {
        void result.body?.cancel().catch(() => {});
        throw new Error('NextResponse.next() and NextResponse.rewrite() are only supported in middleware or proxy, not Route Handlers');
      }
    } catch (error) {
      lifecycle?.controller.abort(error);
      lifecycle?.cleanup();
      throw error;
    } finally { clearTimeout(timeout); }
    const responseHeaders = Object.fromEntries(result.headers);
    delete responseHeaders['x-middleware-set-cookie'];
    const cookies = [...(result.headers.getSetCookie?.() || []), ...changedCookies];
    if (cookies?.length) responseHeaders['set-cookie'] = cookies;
    if (stream) {
      for (const name of Object.keys(responseHeaders)) if (forbiddenHeaders.has(name) || name === 'content-length') delete responseHeaders[name];
      const cancelRequest = reason => lifecycle.controller.abort(reason);
      if (!result.body) {
        lifecycle.cleanup();
        return { status: result.status, headers: responseHeaders, body: Buffer.alloc(0), cancel: () => {} };
      }
      const streamed = streamingBody(result.body, { signal: lifecycle.controller.signal, timeoutMs,
        onCancel: cancelRequest, onComplete: lifecycle.cleanup, runInContext });
      const cancel = reason => streamed.cancel(reason);
      if ((method === 'HEAD' && !preserveHeadBody) || [204, 205, 304].includes(result.status)) {
        await cancel(abortError('HTTP response does not carry a body'));
        return { status: result.status, headers: responseHeaders, body: Buffer.alloc(0), cancel };
      }
      return { status: result.status, headers: responseHeaders, body: streamed, cancel };
    }
    if ((method === 'HEAD' && !preserveHeadBody) || [204, 205, 304].includes(result.status)) {
      await result.body?.cancel();
      return { status: result.status, headers: responseHeaders, body: Buffer.alloc(0) };
    }
    const reader = result.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response exceeds the 16 MiB Rustyx limit'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    return { status: result.status, headers: responseHeaders, body: Buffer.concat(chunks, size) };
  }
  if (mod.config?.api?.bodyParser !== false) request.body = parseBody(bytes, request.headers['content-type']);
  if (stream) return runStreamingPagesApi(mod.default, request, { method, signal, timeoutMs });
  const response = new CapturedResponse(undefined, true);
  let timeout;
  const completed = new Promise((resolve, reject) => {
    response.once('finish', resolve);
    response.once('error', reject);
    timeout = setTimeout(() => reject(new Error('API route did not end its response within 25 seconds')), 25_000);
    timeout.unref();
  });
  // Install a rejection handler before awaiting user code to avoid an unhandled timeout.
  completed.catch(() => {});
  try {
    const result = await Promise.race([Promise.resolve(mod.default(request, response)), completed.then(() => undefined)]);
    if (result !== undefined && result !== response && !response.writableEnded) throw new Error('Pages API handlers must send their response with res.send(), res.json(), or res.end()');
    await completed;
    const captured = response.result();
    return method === 'HEAD' ? { ...captured, body: Buffer.alloc(0) } : captured;
  } finally { clearTimeout(timeout); }
}
