import { trackRequestWork } from './request-work.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadModule } from './module-loader.mjs';
import { NextRequest, NextResponse } from '../compat/server.cjs';
import { removeBasePath } from '../compat/paths.cjs';
import { runRequestContext, currentRequest, runWithoutRequestContext } from '../compat/headers.cjs';
import { flushCacheWork } from '../compat/data-cache.cjs';
import { apiTimeoutError, streamingBody, withSignal } from './stream-utils.mjs';
import { installFetchCache } from './fetch-cache.mjs';

installFetchCache();

const FLIGHT_HEADERS = ['rsc', 'next-router-state-tree', 'x-rustyx-router-state', 'next-router-prefetch', 'next-hmr-refresh', 'next-router-segment-prefetch'];
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
const MAX_BODY = 8 * 1024 * 1024;
const MAX_SCOPES = 32;
const MAX_PROMISES = 128;
const scopes = new Set();
let pendingPromises = 0;

function observeBackground(value, entry) {
  // Keep the reaction detached from the scope closure. A user promise may
  // remain reachable forever; clearing entry.settle after its deadline must
  // release the scope and request while still observing late rejections.
  // Otherwise the child promise itself inherits the request store even after
  // the detachable callback has been cleared. User work keeps its own context.
  runWithoutRequestContext(() => {
    void Promise.resolve(value).then(() => entry.settle?.(), error => entry.settle?.(error));
  });
}

function backgroundScope({ timeoutMs, onTimeout, onError }) {
  const entries = new Set();
  let active = false, completed = false, closed = false, timer, resolveDone;
  const scope = { done: new Promise(resolve => { resolveDone = resolve; }) };
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const entry of entries) { entry.settle = undefined; pendingPromises--; }
    entries.clear(); scopes.delete(scope); resolveDone();
  }
  function settle(entry, error) {
    if (!entry.settle) return;
    entry.settle = undefined; entries.delete(entry); pendingPromises--;
    if (error) onError(error);
    if (completed && !entries.size) close();
  }
  scope.waitUntil = value => {
    // Observe even refused registrations: callers often construct a rejected
    // promise before invoking waitUntil, which must not become unhandled.
    const entry = { settle: undefined };
    observeBackground(value, entry);
    if (closed) throw new Error('waitUntil cannot be called after its middleware invocation has completed');
    if (pendingPromises >= MAX_PROMISES || (!active && scopes.size >= MAX_SCOPES)) throw new Error('Middleware waitUntil capacity exceeded');
    if (!active) {
      active = true; scopes.add(scope);
      timer = setTimeout(() => {
        const error = apiTimeoutError('middleware waitUntil', timeoutMs);
        close(); onTimeout(error); onError(error);
      }, timeoutMs);
    }
    entry.settle = error => settle(entry, error);
    entries.add(entry); pendingPromises++;
  };
  scope.complete = () => { completed = true; if (!entries.size) close(); };
  return scope;
}

// Test/shutdown hooks inspect only framework-owned, bounded work. Arbitrary
// application promises cannot be forcibly canceled after their deadline.
export function middlewareBackgroundState() { return { scopes: scopes.size, promises: pendingPromises }; }
export async function drainMiddlewareWork() { await Promise.all([...scopes].map(scope => scope.done)); }

function visibleHeaders(values, normalize) {
  const headers = new Headers(values);
  for (const name of [...headers.keys()]) if (name.startsWith('x-middleware-') || name === 'x-rustyx-rewrite') headers.delete(name);
  if (normalize) for (const name of FLIGHT_HEADERS) headers.delete(name);
  return headers;
}

export async function runMiddleware(options) {
  const metadata = options.manifest?.middleware || options.middleware || {};
  const production = options.production ?? true;
  const timeoutMs = options.timeoutMs ?? 25_000;
  const normalize = !(options.manifest?.config?.skipProxyUrlNormalize ?? options.manifest?.config?.skipMiddlewareUrlNormalize);
  const exposedUrl = new URL(!normalize && options.originalUrl ? options.originalUrl : options.url);
  if (normalize) exposedUrl.searchParams.delete('_rsc');
  const headers = visibleHeaders(options.headers || {}, normalize);
  const controller = new AbortController();
  const aborted = () => controller.abort(options.signal.reason);
  if (options.signal?.aborted) aborted();
  else options.signal?.addEventListener('abort', aborted, { once: true });
  const headersTimer = setTimeout(() => controller.abort(apiTimeoutError('middleware response headers', timeoutMs)), timeoutMs);
  let responseComplete = false;
  let backgroundTimeout;
  let finalizeInvocation;
  const report = options.onBackgroundError || (error => console.error('[rustyx] Middleware background work failed:', error?.stack || error));
  const background = backgroundScope({ timeoutMs: options.waitUntilTimeoutMs ?? 25_000,
    onError: report, onTimeout(error) { backgroundTimeout = error; if (responseComplete) controller.abort(error); } });
  const finishResponse = () => {
    responseComplete = true;
    options.signal?.removeEventListener('abort', aborted);
    if (backgroundTimeout) controller.abort(backgroundTimeout);
    finalizeInvocation?.();
  };
  let output;
  try {
    const basePath = options.manifest?.config?.basePath || '';
    const internalUrl = new URL(exposedUrl);
    internalUrl.pathname = removeBasePath(internalUrl.pathname, basePath);
    return await runRequestContext({ url: internalUrl.href, basePath, method: options.method || 'GET', headers,
      phase: 'middleware', production, mutableCookies: true, signal: controller.signal }, async () => {
      const context = currentRequest();
      let result;
      let finalized = false;
      finalizeInvocation = () => {
        if (finalized) return;
        finalized = true;
        context.cookies._mutable = false;
        context.cacheState.closed = true;
        if (context.cacheState.pending.size) {
          try { background.waitUntil(flushCacheWork(context)); }
          catch (error) { report(error); }
        }
        background.complete();
      };
      try {
        controller.signal.throwIfAborted();
        const module = await withSignal(loadModule(options.modulePath), controller.signal);
        const exportName = metadata.exportName || metadata.convention || 'middleware';
        const handler = module[exportName];
        if (typeof handler !== 'function') throw new TypeError(`Middleware must export a ${exportName} function`);
        const init = { method: options.method || 'GET', headers, signal: controller.signal };
        if (!['GET', 'HEAD'].includes(init.method)) {
          if (typeof options.body === 'string' && options.body.length > Math.ceil(MAX_BODY / 3) * 4) throw Object.assign(new Error('Middleware request exceeds the 8 MiB Rustyx limit'), { statusCode: 413 });
          const body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body || '', 'base64');
          if (body.byteLength > MAX_BODY) throw Object.assign(new Error('Middleware request exceeds the 8 MiB Rustyx limit'), { statusCode: 413 });
          if (body.byteLength) init.body = body;
        }
        const request = new NextRequest(exposedUrl, { ...init, nextConfig: options.manifest?.config });
        const event = { sourcePage: `/${metadata.convention || 'middleware'}`,
          waitUntil(value) { trackRequestWork(value, options.signal); background.waitUntil(value); }, passThroughOnException() {},
          get request() { throw new Error('Read the request from the middleware function first argument'); },
          respondWith() { throw new Error('Return a Response from the middleware function instead of respondWith()'); } };
        const pending = trackRequestWork(Promise.resolve().then(() => handler(request, event)), options.signal);
        void pending.then(value => { if (controller.signal.aborted && value instanceof Response) void value.body?.cancel(controller.signal.reason).catch(() => {}); }, () => {});
        result = await withSignal(pending, controller.signal);
        if (result === null || result === undefined) result = NextResponse.next();
        if (!(result instanceof Response)) throw new TypeError('Middleware must return a Response, null, or undefined');
        clearTimeout(headersTimer);
        const responseHeaders = Object.fromEntries(result.headers);
        const cookies = [...result.headers.getSetCookie(), ...context.outgoingCookies.values()];
        if (cookies.length) responseHeaders['set-cookie'] = cookies;
        const nominated = String(responseHeaders.connection || '').split(',').map(name => name.trim().toLowerCase());
        for (const name of Object.keys(responseHeaders)) if (HOP_HEADERS.has(name) || nominated.includes(name)) delete responseHeaders[name];
        if (Buffer.byteLength(JSON.stringify(responseHeaders)) > 60 * 1024) throw new Error('Middleware response headers exceed the Rustyx metadata limit');
        // Match native/Next routing precedence: rewrite, then Location, then
        // continuation. A Location-bearing final response may have a body.
        const control = responseHeaders['x-middleware-rewrite'] ||
          (!Object.hasOwn(responseHeaders, 'location') && responseHeaders['x-middleware-next']);
        const noBody = control || init.method === 'HEAD' || [204, 205, 304].includes(result.status);
        if (noBody || !result.body) {
          void result.body?.cancel().catch(() => {});
          finishResponse();
          output = { status: result.status, headers: responseHeaders, body: Buffer.alloc(0), cancel() {} };
        } else {
          const body = streamingBody(result.body, { signal: controller.signal, timeoutMs,
            runInContext: AsyncLocalStorage.snapshot(), onCancel: reason => controller.abort(reason), onComplete: finishResponse });
          output = { status: result.status, headers: responseHeaders, body, cancel: reason => body.cancel(reason) };
        }
        context.cookies._mutable = false;
        context.cacheState.closed = true;
        return { ...output, finalizeCache: finalizeInvocation };
      } catch (error) {
        controller.abort(error);
        void result?.body?.cancel(error).catch(() => {});
        finalizeInvocation();
        throw error;
      }
    });
  } finally {
    clearTimeout(headersTimer);
    if (!output) finishResponse();
  }
}
