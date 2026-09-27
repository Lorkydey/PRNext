import React from 'react';
import { runtimeProfile } from './profile.mjs';
import { fontPreloads } from './font-preload.mjs';
import { advancedRoutingSources } from './app-routing-state.mjs';
import { addBasePath, removeBasePath } from '../compat/paths.cjs';
import { isDynamicBailout } from '../compat/dynamic-bailout.cjs';
import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { workerMetadata } from './worker-metadata.mjs';
import { workerArtifacts } from './worker-artifacts.mjs';
import path from 'node:path';
import { PARTIAL_PREFETCH_TYPE, PARTIAL_PREFETCH_BYTES } from './app-prefetch.mjs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { AppRouterProvider } from '../compat/app-context.cjs';
import { appContent } from './app-content.mjs';
import { escapeHtml, MAX_RESPONSE_BYTES, errorResponse } from './http.mjs';
import { navigationResponse } from './navigation.mjs';
import { appTimeoutError, appErrorDigest } from './app-errors.mjs';
import { parentStreamChannel } from './app-stream-channel.mjs';
import { staticPath } from './pages-paths.mjs';
import { scriptNonce } from './script-html.mjs';
import { installFetchCache } from './fetch-cache.mjs';
import { partialArtifact, partialShell } from './app-partial.mjs';
import { partialKeyMap } from './app-partial-model.mjs';
import { partialIdentity } from './partial-artifact-cache.mjs';
import { isDraftRequest } from '../compat/draft.cjs';

installFetchCache();

const workers = new Map();
const metadata = new WeakMap();
const artifacts = new WeakMap();
const edgeManifests = new WeakMap();
const emptyManifest = Object.freeze({});
let nextId = 0;
const pending = new Map();
// Avoid temporary arrays on every completion/cancellation at high concurrency.
function hasPending(worker, minimum = 1, cancelledOnly = false) {
  let count = 0;
  for (const request of pending.values()) {
    if (request.worker === worker && (!cancelledOnly || request.cancelled) && ++count >= minimum) return true;
  }
  return false;
}
const ssrModules = new Map();
const ssrModuleLoaders = new Map();
const ssrManifests = new WeakMap();
const require = createRequire(import.meta.url);
const flightDecoders = new Map();
let htmlRuntime, recoveryRuntime, domRuntime;
async function renderProgressiveAppHtml(options) {
  htmlRuntime ??= await import('./app-stream-html.mjs');
  return htmlRuntime.renderProgressiveAppHtml(options);
}
async function renderAppRecoveryShell(...args) {
  recoveryRuntime ??= await import('./app-recovery.mjs');
  return recoveryRuntime.renderAppRecoveryShell(...args);
}

function flightDecoder(production) {
  if (flightDecoders.has(production)) return flightDecoders.get(production);
  const filename = path.join(path.dirname(require.resolve('react-server-dom-webpack/client.node')),
    `cjs/react-server-dom-webpack-client.node.${production ? 'production' : 'development'}.js`);
  const previous = process.env.NODE_ENV;
  try {
    // React's development decoder guards module initialization with NODE_ENV.
    // This require is synchronous; restore the host before any stream work.
    process.env.NODE_ENV = production ? 'production' : 'development';
    let decoder = require(filename).createFromNodeStream;
    if (typeof decoder !== 'function') {
      // A consumer may have previously required the guarded development file
      // in production, leaving an empty module in Node's cache.
      delete require.cache[filename];
      decoder = require(filename).createFromNodeStream;
    }
    if (typeof decoder !== 'function') throw new Error('React Flight decoder is unavailable for the requested render mode');
    flightDecoders.set(production, decoder);
    return decoder;
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

// React's official Flight decoder uses this bundler interface. Module IDs are
// absolute SSR bundle URLs here, so applications cannot collide in the registry.
globalThis.__webpack_require__ = id => {
  if (!ssrModules.has(id)) throw new Error(`Unknown App Router client module: ${id}`);
  return ssrModules.get(id);
};
globalThis.__webpack_chunk_load__ = id => {
  const load = ssrModuleLoaders.get(id);
  if (!load) return Promise.reject(new Error(`Unknown App Router client module: ${id}`));
  return load();
};

function getWorker(production) {
  if (workers.has(production)) return workers.get(production);
  const current = new Worker(new URL('./rsc-worker.mjs', import.meta.url), {
    execArgv: ['--conditions=react-server'], stdout: true, stderr: true,
    // Production nursery policy; an explicit Node semi-space flag takes
    // precedence. This does not cap the old generation or process RSS.
    ...(production ? { resourceLimits: { maxYoungGenerationSizeMb: runtimeProfile(process.env, production).youngGenerationMiB } } : {}),
    env: { ...process.env, NODE_ENV: production ? 'production' : 'development' },
  });
  workers.set(production, current);
  metadata.set(current, workerMetadata(current));
  artifacts.set(current, workerArtifacts(current));
  // The HTTP worker's stdout belongs to its Rust transport. User code and React
  // diagnostics in the separate RSC environment must never corrupt that stream.
  current.stdout.pipe(process.stderr);
  current.stderr.pipe(process.stderr);
  function fail(error) {
    if (workers.get(production) === current) workers.delete(production);
    for (const [id, request] of pending) {
      if (request.worker !== current) continue;
      clearTimeout(request.timeout);
      pending.delete(id);
      request.detach?.();
      request.channel?.error(error);
      request.reject(error);
    }
  }
  current.on('message', ({ id, type, chunk, byteOffset, byteLength, done, body, status, rscError, boundaryIndex, headers, error, staticParams, staticMetadata, navigation }) => {
    const request = pending.get(id);
    if (!request || request.worker !== current) return;
    // A timed-out mutation can still be running after its HTTP caller leaves.
    // Its retirement marker must be honored before discarding cancelled output.
    if (error?.retireWorker) {
      if (workers.get(production) === current) workers.delete(production);
      void current.terminate();
    }
    if (request.cancelled && type !== 'settled') return;
    if (type === 'settled') {
      if (!request.cancelled) return;
      pending.delete(id); clearTimeout(request.timeout);
      if (!hasPending(current)) current.unref();
      return;
    }
    if (type === 'start') {
      if (chunk) request.channel.chunk(chunk, byteOffset, byteLength);
      request.resolve({ body: request.channel.body, status: status || 200, rscError, boundaryIndex, headers });
      if (!done) return;
    }
    if (type === 'chunk') {
      try { request.channel.chunk(chunk, byteOffset, byteLength); }
      catch (error) { request.channel.error(error); current.postMessage({ id, type: 'cancel' }); }
      if (!done) return;
    }
    pending.delete(id);
    clearTimeout(request.timeout);
    request.detach?.();
    if (type === 'end' || done) request.channel.end();
    else if (error) {
      const failure = new Error(error.message);
      if (error.stack) failure.stack = error.stack;
      if (error.digest) failure.digest = error.digest;
      if ([400, 504].includes(error.statusCode)) failure.statusCode = error.statusCode;
      if (error.responseHeaders) failure.responseHeaders = error.responseHeaders;
      if (error.code) failure.code = error.code;
      if (error.staticMode) failure.staticMode = error.staticMode;
      if (error.dynamicReason) failure.dynamicReason = error.dynamicReason;
      request.channel?.error(failure);
      request.reject(failure);
    } else if (staticParams && request.operation === 'static-params') {
      request.resolve(staticParams);
    } else if (!(body instanceof ArrayBuffer) || body.byteLength > MAX_RESPONSE_BYTES) {
      request.reject(new Error('Invalid App Router Flight response buffer'));
    } else {
      // ArrayBuffer overload: a view of the transferred allocation, no copy.
      request.resolve({ body: Buffer.from(body), status: status || 200, rscError, boundaryIndex, headers, staticMetadata, navigation });
    }
    if (!hasPending(current)) current.unref();
  });
  current.on('error', fail);
  current.on('exit', code => fail(new Error(`App Router worker exited (${code})`)));
  current.unref();
  return current;
}

export function closeAppRuntime() {
  const current = [...workers.values()];
  workers.clear();
  return Promise.all(current.map(worker => worker.terminate()));
}

export function renderFlight(request, { softTimeoutMs = 25_000, hardTimeoutMs = 28_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const current = getWorker(Boolean(request.production));
    current.ref();
    const id = ++nextId;
    const timeout = setTimeout(() => {
      // A blocking npm dependency cannot honor an AbortSignal. Retire the
      // isolate at the hard deadline so subsequent requests can recover.
      if (workers.get(Boolean(request.production)) === current) workers.delete(Boolean(request.production));
      void current.terminate();
      pending.delete(id);
      const error = appTimeoutError('RSC worker', hardTimeoutMs);
      entry.channel?.error(error);
      entry.detach?.();
      reject(error);
    }, hardTimeoutMs);
    const entry = { worker: current, resolve, reject, timeout, operation: request.operation };
    function cancel(reason) {
      // Keep the independent deadline until the isolate confirms settlement.
      // A disconnected client must not disable recovery of blocked npm code.
      entry.cancelled = true;
      entry.detach?.();
      // HTTP callers can leave faster than arbitrary npm work can unwind.
      // Bound abandoned work independently of the admission of live requests.
      if (hasPending(current, 16, true)) {
        if (workers.get(Boolean(request.production)) === current) workers.delete(Boolean(request.production));
        void current.terminate();
      }
      if (!hasPending(current)) current.unref();
      reject(reason instanceof Error ? reason : new Error('App Router response was cancelled'));
    }
    if (request.stream) entry.channel = parentStreamChannel(current, id, cancel);
    if (signal) {
      const onAbort = () => {
        current.postMessage({ id, type: 'cancel' });
        entry.channel?.error(signal.reason);
        cancel(signal.reason);
      };
      entry.detach = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { clearTimeout(timeout); onAbort(); return; }
    }
    pending.set(id, entry);
    try {
      const wire = { ...request, renderTimeoutMs: softTimeoutMs };
      if (request.production) {
        const artifactId = artifacts.get(current)(wire.partialFlight);
        if (artifactId !== undefined) { wire.partialFlightId = artifactId; delete wire.partialFlight; }
        for (const field of ['clientModules', 'actions']) {
          const key = metadata.get(current)(wire[field]);
          if (key !== undefined) { wire[field + 'Id'] = key; delete wire[field]; }
        }
      }
      current.postMessage({ id, request: wire });
    }
    catch (error) {
      clearTimeout(timeout);
      pending.delete(id);
      entry.detach?.();
      reject(error);
      if (!hasPending(current)) current.unref();
    }
  });
}

export async function decodeFlight(body, clientModules = {}, distDir, { production = process.env.NODE_ENV === 'production' } = {}) {
  const ids = Object.keys(clientModules);
  let cached = ssrManifests.get(clientModules);
  // Keep only the manifest's module mapping, never a decoded React model or
  // request context. Weak ownership releases it with the build manifest.
  if (!cached || cached.distDir !== distDir || ids.length !== cached.paths.size || ids.some(id => cached.paths.get(id) !== clientModules[id].ssrModule)) {
    const moduleMap = Object.create(null), paths = new Map();
    for (const id of ids) {
      const item = clientModules[id];
      const moduleUrl = pathToFileURL(path.resolve(distDir, item.ssrModule)).href;
      if (!ssrModuleLoaders.has(moduleUrl)) ssrModuleLoaders.set(moduleUrl, async () => {
        if (!ssrModules.has(moduleUrl)) ssrModules.set(moduleUrl, await import(moduleUrl));
      });
      moduleMap[id] = { '*': { id: moduleUrl, chunks: [moduleUrl, moduleUrl], name: '*' } };
      paths.set(id, item.ssrModule);
    }
    cached = { distDir, paths, moduleMap };
    ssrManifests.set(clientModules, cached);
  }
  // Hosts can build/render both modes in one process. The encoded protocol,
  // rather than the host's current environment or import cache, selects React.
  const decoder = flightDecoder(Boolean(production));
  return decoder(body instanceof ReadableStream ? Readable.fromWeb(body) : Readable.from([body]), { moduleMap: cached.moduleMap, serverModuleMap: null, moduleLoading: null });
}

export async function renderHtml(tree, router, { timeoutMs = 25_000, formState = null, staticGeneration = false, nonce, strictMode = true } = {}) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(appTimeoutError('HTML render', timeoutMs)), timeoutMs);
  let renderError;
  try {
    domRuntime ??= await import('react-dom/server');
    const stream = await domRuntime.renderToReadableStream(React.createElement(strictMode ? React.StrictMode : React.Fragment, null, React.createElement(AppRouterProvider, { router, nonce }, appContent(tree))), {
      nonce,
      signal: abort.signal, onError(error) {
        if (isDynamicBailout(error)) return error.digest;
        // Suspense can recover client SSR failures by emitting its fallback and
        // retrying in the browser. Static generation must still reject them:
        // publishing that fallback would replace the last valid cached page.
        if (staticGeneration || navigationResponse(error)) renderError ??= error;
        else if (!abort.signal.aborted) console.error('[prnext]', error?.stack || error);
        return appErrorDigest(error);
      },
      formState,
    });
    const reader = stream.getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          const error = new Error('HTML response exceeds the 16 MiB PRNext limit');
          abort.abort(error);
          await reader.cancel(error);
          throw error;
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    if (abort.signal.aborted) throw abort.signal.reason;
    if (renderError) throw renderError;
    return Buffer.concat(chunks, length).toString('utf8');
  } catch (error) {
    if (abort.signal.aborted && abort.signal.reason?.statusCode === 504) throw abort.signal.reason;
    throw error;
  } finally { clearTimeout(timeout); }
}

function beforeClosingTag(html, tag, content) {
  const index = html.lastIndexOf(`</${tag}>`);
  if (index < 0) throw new Error(`App Router root layout must render a <${tag}> element`);
  return `${html.slice(0, index)}${content}${html.slice(index)}`;
}

export function completeAppHtml(html, flight, route = {}) {
  if (!/<html(?:\s|>)/i.test(html) || !/<body(?:\s|>)/i.test(html)) {
    throw new Error('App Router root layout must render <html> and <body> elements');
  }
  const styles = fontPreloads(route.fonts, route.nonce) + (route.css || []).map(href => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('');
  if (styles) html = beforeClosingTag(html, 'head', styles);
  const payload = `<script id="__PRNEXT_FLIGHT__" type="application/octet-stream">${flight.toString('base64')}</script>`;
  const bootstrap = route.client ? `<script type="module"${route.nonce ? ` nonce="${escapeHtml(route.nonce)}"` : ''} src="${escapeHtml(route.client)}"></script>` : '';
  html = beforeClosingTag(html, 'body', `${payload}${bootstrap}`);
  if (!html.startsWith('<!DOCTYPE html>')) html = `<!DOCTYPE html>${html}`;
  if (Buffer.byteLength(html) > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 16 MiB PRNext limit');
  return html;
}

const devStaticChecks = new Map();

export async function renderAppPage(options) {
  const response = await renderAppPageInner(options);
  if (options.method !== 'POST' && response.headers?.location) response.headers.location = addBasePath(response.headers.location, options.manifest?.config?.basePath || '');
  return response;
}

async function renderAppPageInner({ modulePath, route = {}, manifest = {}, distDir = path.dirname(path.dirname(modulePath)), url = 'http://localhost/', originalUrl, params = {}, method = 'GET', headers = {}, routingRequestHeaders, routingResolver, body = '', production = process.env.NODE_ENV === 'production', stream = false, signal }) {
  let clientModules = manifest.app?.clientModules || emptyManifest;
  if (route.cacheConfig?.runtime === 'edge') {
    let edge = !manifest.dev && edgeManifests.get(clientModules);
    if (!edge) {
      edge = Object.fromEntries(Object.entries(clientModules).map(([id, item]) => [id, item.edgeSsrModule ? { ...item, ssrModule: item.edgeSsrModule } : item]));
      if (!manifest.dev) edgeManifests.set(clientModules, edge);
    }
    clientModules = edge;
  }
  const responseHeaders = { 'cache-control': 'private, no-cache, no-store, max-age=0', vary: 'RSC' };
  const request = { modulePath, routePattern: route.pattern, cacheConfig: route.cacheConfig, css: route.css || [], fonts: route.fonts || [], nonce: scriptNonce(headers), basePath: manifest.config?.basePath || '', trailingSlash: manifest?.config?.trailingSlash || false, skipTrailingSlashRedirect: manifest?.config?.skipTrailingSlashRedirect || false, url, originalUrl, params, method, headers, clientModules, production,
    distDir, strictMode: manifest.config?.reactStrictMode !== false, cacheComponents: manifest.config?.cacheComponents, cacheLife: manifest.config?.cacheLife, cacheHandlers: manifest.config?.cacheHandlers, cacheHandler: manifest.config?.cacheHandler, cacheMaxMemorySize: manifest.config?.cacheMaxMemorySize, serverActions: manifest.config?.serverActions, previewModeId: manifest.previewModeId, actions: manifest.app?.actions || emptyManifest, actionKey: manifest.app?.actionKey };
  if (route.parallel) {
    request.routingResolver = routingResolver;
    request.skipProxyUrlNormalize = manifest.config?.skipProxyUrlNormalize;
    request.skipMiddlewareUrlNormalize = manifest.config?.skipMiddlewareUrlNormalize;
    request.routingRequestHeaders = routingRequestHeaders;
    request.routingSources = advancedRoutingSources(request, manifest.routes || []);
    request.routingMiddleware = manifest.middleware;
    request.interception = route.interception;
  }
  if (manifest.dev && method !== 'POST' && !(manifest.appNotFound && route.id === manifest.appNotFound)) {
    const listing = await renderFlight({ ...request, operation: 'static-params' }, { signal });
    if (route.pattern?.includes('[') && route.cacheConfig?.dynamicParams === false) {
      const requested = staticPath(route.pattern, new URL(url).pathname).path;
      if (!listing.generated || !listing.params.some(params => staticPath(route.pattern, { params }).path === requested)) {
        return { status: 404, headers: { ...responseHeaders, 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Not Found') };
      }
    }
    if (request.cacheComponents) {
      const key = `${manifest.cacheId}:${route.id}:${new URL(url).pathname}`;
      let check = devStaticChecks.get(key);
      if (!check) {
        if (listing.generated && listing.params.length === 0) throw new Error(`generateStaticParams for ${route.pattern} must return at least one parameter object when cacheComponents is enabled.`);
        check = import('./app-static.mjs').then(({ prerenderAppRoute }) => prerenderAppRoute({ modulePath, distDir, route, manifest,
          production, path: new URL(url).pathname, params, partialParams: listing.generated ? [] : Object.keys(params) })).then(() => import('./app-instant.mjs')).then(({ validateInstantRoute }) => validateInstantRoute({ modulePath, distDir, route, manifest, production, path: new URL(url).pathname, params }));
        if (devStaticChecks.size >= 128) devStaticChecks.delete(devStaticChecks.keys().next().value);
        devStaticChecks.set(key, check);
      }
      request.instantDiagnostics = await check;
    }
  }
  const header = name => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  if (method === 'POST') {
    const id = header('next-action');
    if (id && !Object.hasOwn(request.actions, id)) return { status: 404, headers: responseHeaders, body: Buffer.from('Unknown Server Action') };
    const limit = request.serverActions?.bodySizeLimit || 1024 * 1024;
    const oversized = () => ({ status: 413, headers: responseHeaders, body: Buffer.from(`Server Action body exceeds the ${limit} byte limit`) });
    if (!Buffer.isBuffer(body) && (body || '').length > Math.ceil(limit / 3) * 4) return oversized();
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'base64');
    if (bytes.byteLength > limit) return oversized();
    request.action = { id, contentType: header('content-type'), body: bytes };
  }
  if (!manifest.dev && request.cacheComponents && (route.ppr || route.pprFallback) && ['GET', 'HEAD'].includes(method) &&
      !request.nonce && !(route.parallel && header('x-prnext-router-state')) && !isDraftRequest(request)) {
    const pathname = staticPath(route.pattern, new URL(url).pathname).path;
    const generic = route.pprGeneric?.find(item => Object.entries(item.params).every(([name, value]) => JSON.stringify(params[name]) === JSON.stringify(value)));
    const filename = (!originalUrl ? route.ppr?.[pathname] : undefined) || generic?.file;
    if (filename || route.pprFallback) {
      const artifact = await partialArtifact({ request, route, manifest, filename, identity: filename === generic?.file ? filename : `${pathname}:${originalUrl ? new URL(originalUrl).pathname : ''}`, signal,
        regenerate: async build => (await import('./app-static.mjs')).prerenderAppRoute({ modulePath, route, manifest, distDir, production,
          path: build?.generic?.path || pathname, originalUrl: build?.generic ? undefined : originalUrl,
          params: build?.generic?.params || params, partialParams: build?.generic?.unknown }),
      });
      if (!artifact.dynamic) return renderPartialAppPage({ request, route, artifact, responseHeaders, stream, signal, rsc: header('rsc') === '1', prefetch: header('x-prnext-prefetch') === '1', knownPrefetch: header('x-prnext-prefetch-known'),
        concrete: artifact.generic ? (continuationSignal => partialArtifact({ request, route, manifest, identity: `concrete:${pathname}:${originalUrl ? new URL(originalUrl).pathname : ''}`, signal: continuationSignal,
          regenerate: async () => (await import('./app-static.mjs')).prerenderAppRoute({ modulePath, route, manifest, distDir, production, path: pathname, originalUrl, params, seed: artifact }),
        })) : undefined });
    }
  }
  // An unsupported speculative request must not execute private components.
  if (header('x-prnext-prefetch') === '1' && method === 'GET') return { status: 204, headers: responseHeaders, body: Buffer.alloc(0) };
  if (stream && (!request.action || request.action.id)) {
    let progressive;
    try {
      progressive = await renderFlight({ ...request, stream: true }, { signal });
      const rsc = Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'rsc' && value === '1');
      if (rsc || request.action?.id) {
        if (method === 'HEAD') await progressive.body.cancel();
        return { ...progressive, headers: { ...responseHeaders, ...progressive.headers, 'content-type': 'text/x-component; charset=utf-8' }, ...(method === 'HEAD' ? { body: Buffer.alloc(0) } : {}) };
      }
      const html = await renderProgressiveAppHtml({ result: progressive, request, route, responseHeaders, decodeFlight, signal });
      if (method === 'HEAD') { await html.cancel(); return { ...html, body: Buffer.alloc(0) }; }
      return html;
    } catch (error) {
      await progressive?.body.cancel(error).catch(() => {});
      if (signal?.aborted || error?.statusCode === 504 || error?.code === 'PRNEXT_INVALID_ROOT_LAYOUT') throw error;
      const navigation = navigationResponse(error);
      if (navigation) return { ...navigation, headers: { ...responseHeaders, ...navigation.headers, ...error.responseHeaders } };
      if (request.action) {
        const result = errorResponse(error, production);
        return { ...result, headers: { ...responseHeaders, ...result.headers, ...error.responseHeaders } };
      }
      // The HTML stream already retains the original Flight data for recovery.
      // Transport, import and resource-limit failures must not replay user code.
      throw error;
    }
  }
  let result;
  try { result = await renderFlight(request, { signal }); }
  catch (error) {
    const result = navigationResponse(error);
    if (result) return { ...result, headers: { ...responseHeaders, ...result.headers, ...error.responseHeaders } };
    if (request.action) {
      const result = errorResponse(error, production);
      return { ...result, headers: { ...responseHeaders, ...result.headers, ...error.responseHeaders } };
    }
    throw error;
  }
  Object.assign(responseHeaders, result.headers);
  if (result.status === 303) return { status: 303, headers: responseHeaders, body: Buffer.alloc(0) };
  const rsc = Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'rsc' && value === '1');
  if (rsc || request.action?.id) return { status: result.status, headers: { ...responseHeaders, 'content-type': 'text/x-component; charset=utf-8' }, body: result.body };
  let html, model, recovery = false;
  try {
    model = await decodeFlight(result.body, clientModules, distDir, { production });
    html = await renderHtml(model.tree, model.router, { formState: model.formState, nonce: request.nonce, strictMode: manifest.config?.reactStrictMode !== false });
  } catch (error) {
    if (error?.statusCode === 504) throw error;
    const navigation = navigationResponse(error);
    if (navigation && !(route.parallel && navigation.status === 404)) return { ...navigation, headers: { ...responseHeaders, ...navigation.headers } };
    // React boundaries run in the browser, including for SSR failures. Keep
    // the original Flight tree so the correct local/global boundary handles
    // its error without rerunning layouts, data fetches or Server Actions.
    console.error('[prnext]', error?.stack || error);
    html = await renderAppRecoveryShell(model?.head, { signal });
    recovery = true;
  }
  const { body: flight, status } = result;
  html = completeAppHtml(html, flight, { ...route, nonce: request.nonce, ...(recovery ? { css: [], fonts: [] } : {}) });
  // A Flight error inside Suspense need not fail the HTML shell. Only shell
  // failure selects 500 for an ordinary GET; action/navigation statuses remain.
  const htmlStatus = result.rscError && status === 500 && ['GET', 'HEAD'].includes(method) ? 200 : status;
  return { status: recovery ? route.parallel && status === 404 ? 404 : 500 : htmlStatus, headers: { ...responseHeaders, 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html) };
}

async function renderPartialAppPage({ request, route, artifact, responseHeaders, stream, signal, rsc, concrete, prefetch, knownPrefetch }) {
  const keys = [...partialKeyMap(artifact.keyScopes, request.params, removeBasePath(new URL(request.url).pathname, request.basePath))];
  const partialRequest = { ...request, partialFlight: artifact.flight, ...(keys.length ? { partialKeys: keys } : {}) };
  const headers = { ...artifact.headers, ...responseHeaders, 'x-prnext-prerender': artifact.complete ? 'complete' : 'partial', 'content-type': rsc ? 'text/x-component; charset=utf-8' : 'text/html; charset=utf-8' };
  const identity = partialIdentity(artifact);
  headers['x-prnext-ppr-id'] = identity;
  if (prefetch) {
    if (route.parallel) return { status: 204, headers: responseHeaders, body: Buffer.alloc(0) };
    const value = { version: 1, id: identity, ...(knownPrefetch?.split(',').includes(identity) ? {} : { flight: artifact.flight }), keys, unknownParams: !!artifact.generic,
      router: { pathname: new URL(request.originalUrl || request.url).pathname, search: new URL(request.originalUrl || request.url).search, params: request.params, basePath: request.basePath } };
    const body = Buffer.from(JSON.stringify(value));
    if (body.byteLength > PARTIAL_PREFETCH_BYTES) return { status: 204, headers: responseHeaders, body: Buffer.alloc(0) };
    return { status: 200, headers: { ...headers, 'content-type': PARTIAL_PREFETCH_TYPE }, body };
  }
  if (artifact.complete) return { status: artifact.status || 200, headers, body: request.method === 'HEAD' ? Buffer.alloc(0) : rsc ? Buffer.from(artifact.flight, 'base64') : Buffer.from(artifact.shell) };
  if (request.method === 'HEAD') return { status: 200, headers, body: Buffer.alloc(0) };
  async function continueFlight(continuationSignal, streaming) {
    const resolved = concrete ? await concrete(continuationSignal) : artifact;
    if (resolved.complete) {
      const bytes = Buffer.from(resolved.flight, 'base64');
      return { status: resolved.status || 200, headers: resolved.headers || {}, body: streaming
        ? new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) : bytes };
    }
    return renderFlight({ ...partialRequest, partialFlight: resolved.flight || artifact.flight, stream: streaming }, { signal: continuationSignal });
  }
  if (rsc) {
    const result = await continueFlight(signal, stream);
    return { ...result, headers: { ...headers, ...result.headers } };
  }
  const shell = partialShell(artifact, route);
  const abort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let rendered;
  const cancel = async reason => { abort.abort(reason || new Error('Partial response cancelled')); await rendered?.cancel?.(reason); };
  const body = (async function* () {
    let sent = 0;
    const bounded = chunk => {
      sent += chunk.byteLength;
      if (sent > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 16 MiB PRNext limit');
      return chunk;
    };
    try {
      // The committed bytes come straight from prerender. Even a blocked
      // request component cannot hold back this shared document shell.
      yield bounded(Buffer.from(shell.replace(/<\/body><\/html>$/i, '')));
      const result = await continueFlight(combinedSignal, true);
      rendered = await renderProgressiveAppHtml({ result, request, route, responseHeaders, decodeFlight, signal: combinedSignal,
        partial: { shell, postponed: artifact.postponed, shellSent: true, resumeKeys: keys.map(([from, to]) => [to, from]) } });
      for await (const chunk of rendered.body) yield bounded(chunk);
    } finally { await cancel(); }
  })();
  if (stream) return { status: 200, headers, body, cancel };
  const chunks = [];
  let size = 0;
  for await (const chunk of body) { size += chunk.byteLength; if (size > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the 16 MiB PRNext limit'); chunks.push(chunk); }
  return { status: 200, headers, body: Buffer.concat(chunks, size) };
}
