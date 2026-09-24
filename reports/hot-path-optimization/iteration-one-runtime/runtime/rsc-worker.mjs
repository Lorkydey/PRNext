import React from 'react';
import { flightBundler } from './worker-metadata.mjs';
import { removeBasePath, normalizeTrailingSlash } from '../compat/paths.cjs';
import { renderToReadableStream } from 'react-server-dom-webpack/server.node';
import { createFromReadableStream } from 'react-server-dom-webpack/client.edge';
import { parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { Metadata } from './app-metadata.mjs';
import { appTimeoutError } from './app-errors.mjs';
import { paramsBySegment, selectedLayoutSegments } from './app-segments.mjs';
import { instantEnabled } from '../compat/instant.cjs';
import { createAdvancedTree, loadAdvancedRouting } from './app-routing.mjs';
import { authorizeAdvancedRouting } from './app-routing-access.mjs';
import { routingBranchRenderer } from './app-routing-context.mjs';
import { runAction } from './action-server.mjs';
import { workerStreamChannel, APP_STREAM_CHUNK_BYTES } from './app-stream-channel.mjs';
import { flushCacheWork, getCachePaths } from '../compat/data-cache.cjs';
import { staticMetadata, staticSearchParams, staticParams, trackStaticDependency } from '../compat/static-generation.cjs';
import { collectStaticParams, validateRuntimeStaticConfig } from './app-static-params.mjs';
import { navigationResponse } from './navigation.mjs';
import { installFetchCache } from './fetch-cache.mjs';
import { flightConsumer } from './cache-components-rsc.mjs';
import { partialModel, isPartialHole, boundedPartialFlight } from './app-partial-model.mjs';
import { PartialTemplates, canResumePartialDirectly, partialTemplateReuse } from './partial-template.mjs';

installFetchCache();

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const routeEntries = new Map();
const partialTemplates = new PartialTemplates();
async function routeEntry(request) {
  const key = request.modulePath;
  if (request.production && routeEntries.has(key)) {
    const entry = routeEntries.get(key);
    routeEntries.delete(key); routeEntries.set(key, entry);
    return entry;
  }
  const entry = await import(pathToFileURL(key).href);
  if (request.production) {
    if (routeEntries.size >= 64) routeEntries.delete(routeEntries.keys().next().value);
    routeEntries.set(key, entry);
  }
  return entry;
}

function component(module, name) {
  const value = module?.default;
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) {
    throw new Error(`App Router ${name} must export a React component as default`);
  }
  return value;
}

function queryObject(url) {
  const values = Object.create(null);
  for (const [name, value] of url.searchParams) {
    if (name === '_rsc') continue;
    if (!Object.hasOwn(values, name)) values[name] = value;
    else values[name] = [...(Array.isArray(values[name]) ? values[name] : [values[name]]), value];
  }
  // Client pages receive this promise through Flight, which requires ordinary
  // plain objects. Spread preserves an own __proto__ query without invoking it.
  return { ...values };
}

function createTree(entry, request, fallback = null) {
  const params = staticParams(request.params || {});
  const searchParams = staticSearchParams(queryObject(new URL(request.url)), currentRequest(), entry.page?.default?.$$typeof === Symbol.for('react.client.reference'));
  if (entry.routing && !fallback) return createAdvancedTree(entry, request, searchParams);
  const segments = entry.segments || [];
  const page = fallback?.kind === 'not-found' ? segments[fallback.index].notFound : entry.page;
  const pageKey = `${request.routePattern || new URL(request.url).pathname}:${JSON.stringify(request.params || {})}`;
  const keyScopes = [];
  const instantTrees = [];
  const instantDisabled = [entry.pageConfig, ...segments.map(segment => segment.staticConfig)].some(config => config?.instant && typeof config.instant === 'object' && (config.instant.unstable_disableValidation || (request.production ? config.instant.unstable_disableBuildValidation : config.instant.unstable_disableDevValidation)));
  function keyScope(prefix, values, liveProps) {
    const key = prefix + JSON.stringify(values);
    keyScopes.push({ key, prefix, names: Object.keys(values), ...(liveProps ? { liveProps } : {}) });
    return key;
  }
  if (request.partialParams?.length) keyScope(`${request.routePattern || new URL(request.url).pathname}:`, request.params || {});
  const metadata = React.createElement(RouteMetadata, { key: 'metadata' });
  const head = request.cacheComponents ? React.createElement(React.Suspense, { fallback: null, key: 'metadata-boundary' }, metadata) : metadata;
  const rootLayout = segments.find(segment => segment.layout);
  let tree = null;
  if (fallback?.kind !== 'error') {
    const Page = component(page, fallback ? 'not-found' : 'page');
    tree = !fallback && entry.ClientPageRoot && Page.$$typeof === Symbol.for('react.client.reference')
      ? React.createElement(entry.ClientPageRoot, { Component: Page, params, searchParams, key: pageKey })
      : React.createElement(Page, { params, searchParams, key: pageKey });
  }
  const scopes = new Map();
  const scopedParams = paramsBySegment(segments, request.params || {});
  for (const segment of segments) {
    scopes.set(segment, `${segment.path || ''}:${JSON.stringify(scopedParams.get(segment))}`);
    if (request.partialParams?.length) for (const prefix of ['', 'error:', 'navigation:', 'layout:']) keyScope(`${prefix}${segment.path || ''}:`, scopedParams.get(segment), prefix === 'layout:' ? ['segments'] : undefined);
  }
  let instantConfig = entry.pageConfig?.instant;
  for (const segment of [...(fallback ? segments.slice(0, fallback.index + 1) : segments)].reverse()) {
    if (segment.loading) tree = React.createElement(React.Suspense, {
      fallback: React.createElement(component(segment.loading, 'loading')),
    }, tree);
    if (request.instantValidation && !instantDisabled && segment.layout) {
      if (instantEnabled(instantConfig, request.production)) instantTrees.push({ path: segment.path || '/', tree: React.createElement(React.Fragment, null, tree) });
      if (segment.staticConfig?.instant !== undefined) instantConfig = segment.staticConfig.instant;
    }
    if (segment.error && entry.ErrorBoundary) tree = React.createElement(entry.ErrorBoundary, {
      errorComponent: component(segment.error, 'error'),
      initialError: fallback?.kind === 'error' && fallback.index === segments.indexOf(segment) ? fallback.error : null,
      resetKey: request.renderKey,
      key: `error:${scopes.get(segment)}`,
    }, tree);
    if (entry.NavigationBoundary && (segment.notFound || segment === segments[0])) tree = React.createElement(entry.NavigationBoundary, {
      notFound: segment.notFound ? React.createElement(component(segment.notFound, 'not-found')) : React.createElement('h1', null, '404: This page could not be found.'),
      resetKey: request.renderKey,
      key: `navigation:${scopes.get(segment)}`,
    }, tree);
    if (segment.template) {
      const child = segments[segments.indexOf(segment) + 1];
      tree = React.createElement(component(segment.template, 'template'), { key: child ? scopes.get(child) : pageKey }, tree);
    }
    if (segment.layout) {
      if (request.cacheComponents && segment === rootLayout) tree = React.createElement(React.Fragment, null, head, tree);
      tree = React.createElement(component(segment.layout, 'layout'), { params: staticParams(scopedParams.get(segment)), key: scopes.get(segment) }, tree);
      if (entry.LayoutProvider) tree = React.createElement(entry.LayoutProvider, { key: `layout:${scopes.get(segment)}`,
        segments: { children: selectedLayoutSegments(segments.slice(segments.indexOf(segment) + 1), request.params) } }, tree);
    }
  }
  // Keep module namespaces out of development owner props: they can contain
  // large application exports which need not be serialized as Flight debug data.
  async function RouteMetadata() {
    const pathname = request.originalUrl
      ? removeBasePath(new URL(request.originalUrl).pathname, request.basePath)
      : new URL(request.url).pathname;
    return runRequestContext({ ...currentRequest(), metadataRendering: true }, () =>
      Metadata({ entry, params, searchParams, pathname, notFoundIndex: fallback?.index ?? -1 }));
  }
  return { tree: request.cacheComponents ? tree : React.createElement(React.Fragment, null, head, tree), head, rootLayout: entry.rootLayout,
    ...(keyScopes.length ? { keyScopes } : {}), ...(request.instantValidation ? { instantTrees } : {}) };
}

function ordinaryRenderError(error) {
  return error && error.code !== 'RUSTYX_DYNAMIC_SERVER_USAGE' && !isPartialHole(error) && error.statusCode !== 504 && !navigationResponse(error);
}

function publicError(error, production) {
  const digest = typeof error?.digest === 'string' ? error.digest : createHash('sha256').update(String(error?.stack || error?.message || error)).digest('hex').slice(0, 16);
  return { message: production ? 'An error occurred while rendering this page. See the server logs for details.' : error?.message || String(error), digest };
}

function errorBoundary(entry, error, production, before = Infinity) {
  const index = entry.ErrorBoundary ? (entry.segments || []).findLastIndex((segment, index) => index < before && segment.error) : -1;
  return index < 0 ? null : { kind: 'error', index, error: publicError(error, production) };
}

async function renderFlight(request, fallback = null, channel = null) {
  return runRequestContext({ ...request, phase: 'render' }, async () => {
    const cacheContext = currentRequest();
    try {
      trackStaticDependency({ paths: getCachePaths(cacheContext) }, cacheContext);
      const allowedRouting = request.controlModel || await authorizeAdvancedRouting(request, channel?.signal);
      const module = await routeEntry(request);
      const entry = allowedRouting ? await loadAdvancedRouting(module, request) : module;
      if (!allowedRouting) request.responseStatus = 400;
      if (cacheContext.staticState) validateRuntimeStaticConfig(entry);
      if (request.actionNotFound && !fallback) {
        const index = (entry.segments || []).findLastIndex(segment => segment.notFound);
        if (index < 0) throw Object.assign(new Error('Not Found'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
        fallback = { kind: 'not-found', index };
      }
      if (request.fallbackError && !fallback) {
        fallback = errorBoundary(entry, request.fallbackError, request.production, request.beforeErrorBoundary);
        if (!fallback) throw Object.assign(new Error(request.fallbackError.message), request.fallbackError);
      }
      const url = new URL(request.url);
      url.searchParams.delete('_rsc');
      const visible = request.originalUrl ? new URL(request.originalUrl) : url;
      visible.searchParams.delete('_rsc');
      const router = { pathname: request.originalUrl ? removeBasePath(visible.pathname, request.basePath) : normalizeTrailingSlash(visible.pathname, request), basePath: request.basePath || '', trailingSlash: request.trailingSlash || false, skipTrailingSlashRedirect: request.skipTrailingSlashRedirect || false, search: request.cacheConfig?.dynamic === 'force-static' ? '' : visible.search, params: request.params || {},
        ...(request.originalUrl ? { pageSearch: url.search } : {}),
        ...(request.cacheConfig?.dynamic === 'force-static' ? { forceStatic: true } : {}) };
      const bundlerConfig = flightBundler(request.clientModules);
      const abort = new AbortController();
      const timeoutMs = request.renderTimeoutMs ?? 25_000;
      const timeout = setTimeout(() => abort.abort(appTimeoutError('RSC render', timeoutMs)), timeoutMs);
      let renderError;
      try {
        if (request.routingContexts?.size) request.renderRoutingBranch = routingBranchRenderer(cacheContext, bundlerConfig,
          channel ? AbortSignal.any([abort.signal, channel.signal]) : abort.signal, error => publicError(error, request.production).digest);
        let model = request.controlModel || { ...(allowedRouting ? createTree(entry, request, fallback) : { tree: null, routingInvalid: true }), router, css: request.css || [], fonts: request.fonts || [], ...(request.instantDiagnostics?.length ? { instantDiagnostics: request.instantDiagnostics } : {}), ...request.actionModel };
        if (model.routing?.params) model.router.params = model.routing.params;
        if (request.partialFlight) {
          const consumer = { serverConsumerManifest: flightConsumer(request), replayConsoleLogs: false };
          const decode = () => {
            const bytes = Buffer.from(request.partialFlight, 'base64');
            return createFromReadableStream(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), consumer);
          };
          const stored = request.production
            ? await partialTemplates.get(request.partialFlight, consumer.serverConsumerManifest, decode, channel ? AbortSignal.any([abort.signal, channel.signal]) : abort.signal)
            : await decode();
          const live = !model.routing && canResumePartialDirectly(stored) ? model : await createFromReadableStream(boundedPartialFlight(renderToReadableStream(model, bundlerConfig, {
            signal: channel ? AbortSignal.any([abort.signal, channel.signal]) : abort.signal,
            onError(error) { return publicError(error, request.production).digest; },
          })), consumer);
          const keyMap = request.partialKeys ? new Map(request.partialKeys) : undefined;
          model = partialModel(stored, { live, keyMap, reuse: partialTemplateReuse(stored, keyMap) });
        }
        const stream = renderToReadableStream(model, bundlerConfig, {
          signal: channel ? AbortSignal.any([abort.signal, channel.signal]) : abort.signal,
          temporaryReferences: request.temporaryReferences,
          onError(error) {
            const failure = error && typeof error === 'object' ? error : new Error(String(error));
            if (cacheContext.staticState?.partial && isPartialHole(failure)) return 'RUSTYX_PPR_DYNAMIC';
            renderError ??= failure;
            const digest = publicError(failure, request.production).digest;
            if (!abort.signal.aborted && !channel?.signal.aborted && ordinaryRenderError(failure)) console.error(`[rustyx] ${digest}`, failure?.stack || failure);
            return digest;
          },
        });
        const reader = stream.getReader();
        const chunks = [];
        let length = 0;
        let lookahead;
        try {
          for (;;) {
            channel?.signal.throwIfAborted();
            const nextRead = lookahead || reader.read();
            lookahead = undefined;
            let { value, done } = await nextRead;
            if (done) break;
            length += value.byteLength;
            if (length > MAX_RESPONSE_BYTES) {
              const error = new Error('Flight response exceeds the 16 MiB Rustyx limit');
              abort.abort(error);
              await reader.cancel(error);
              throw error;
            }
            if (channel) {
              // Flight frequently emits several small rows in one render turn.
              // Coalesce only reads that are already resolved; an async child
              // must never hold back the shell while this batch is assembled.
              const batch = [value];
              let batchLength = value.byteLength;
              function prefetch() {
                const state = {};
                lookahead = reader.read().then(result => { state.result = result; return result; });
                lookahead.catch(() => {});
                return state;
              }
              let next = prefetch();
              if (!channel.started) await new Promise(resolve => setImmediate(resolve));
              else await Promise.resolve();
              while (next.result && !next.result.done && batch.length < 64 && batchLength + next.result.value.byteLength <= APP_STREAM_CHUNK_BYTES) {
                batch.push(next.result.value);
                batchLength += next.result.value.byteLength;
                length += next.result.value.byteLength;
                if (length > MAX_RESPONSE_BYTES) {
                  const error = new Error('Flight response exceeds the 16 MiB Rustyx limit');
                  abort.abort(error);
                  await reader.cancel(error);
                  throw error;
                }
                next = prefetch();
                await Promise.resolve();
              }
              // Errors discovered while constructing the first Flight chunk can
              // still select an HTTP status or render the nearest fallback.
              if (!channel.started && !request.partialFlight && renderError && !ordinaryRenderError(renderError) && !(entry.routing && renderError.digest === 'NEXT_HTTP_ERROR_FALLBACK;404')) { await reader.cancel(renderError); break; }
              if (batch.length > 1) {
                value = new Uint8Array(batchLength);
                let offset = 0;
                for (const item of batch) { value.set(item, offset); offset += item.byteLength; }
              }
              if (!channel.started) channel.start({ status: request.partialFlight ? 200 : fallback?.kind === 'not-found' || (entry.routing && renderError?.digest === 'NEXT_HTTP_ERROR_FALLBACK;404') ? 404 : renderError || fallback?.kind === 'error' ? 500 : request.responseStatus || 200,
                rscError: Boolean(ordinaryRenderError(renderError)), boundaryIndex: fallback?.index, headers: request.responseHeaders });
              await channel.write(value, abort.signal, Boolean(next.result?.done));
              continue;
            }
            // The byte stream hands ownership of each Uint8Array to its reader.
            // Retain those chunks until assembly instead of copying them again.
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        if (abort.signal.aborted) throw abort.signal.reason;
        if (cacheContext.staticState?.error) throw cacheContext.staticState.error;
        let staticNavigation;
        if (renderError) {
          if (renderError.code === 'RUSTYX_DYNAMIC_SERVER_USAGE') throw renderError;
          // After the shell is sent, React's encoded error/digest and the client
          // navigation/error boundaries complete the response in-band.
          if (channel?.started && renderError.statusCode !== 504) { channel.end(); return; }
          if (renderError.digest === 'NEXT_HTTP_ERROR_FALLBACK;404' && !entry.routing) {
            const boundary = (entry.segments || []).findLastIndex((segment, index) => index < (fallback?.index ?? Infinity) && segment.notFound);
            if (boundary >= 0) return renderFlight({ ...request, cacheState: cacheContext.cacheState, staticState: cacheContext.staticState }, { kind: 'not-found', index: boundary }, channel);
          } else if (ordinaryRenderError(renderError)) {
            if (cacheContext.staticState) throw renderError;
            // Preserve the original errored Flight tree. React's browser
            // boundaries know the exact failing subtree; replaying the route
            // here both repeats user effects and can select a child boundary
            // for an exception actually thrown by its parent layout.
          }
          if (!ordinaryRenderError(renderError) && !(entry.routing && renderError.digest === 'NEXT_HTTP_ERROR_FALLBACK;404')) {
            staticNavigation = cacheContext.staticState && navigationResponse(renderError);
            if (!staticNavigation) throw renderError;
          }
        }
        if (channel) {
          if (!channel.started) channel.start({ status: request.responseStatus || 200, headers: request.responseHeaders });
          channel.end();
          return;
        }
        // A dedicated ArrayBuffer is transferable even for small responses; a
        // pooled Node Buffer could otherwise clone its entire allocation pool.
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { body: body.buffer, status: staticNavigation?.status || (fallback?.kind === 'not-found' || (entry.routing && renderError?.digest === 'NEXT_HTTP_ERROR_FALLBACK;404') ? 404 : renderError || fallback?.kind === 'error' ? 500 : request.responseStatus || 200),
          rscError: Boolean(ordinaryRenderError(renderError)), boundaryIndex: fallback?.index, headers: { ...request.responseHeaders, ...staticNavigation?.headers },
          ...(staticNavigation ? { navigation: { status: staticNavigation.status, body: String(staticNavigation.body || '') } } : {}),
          ...(cacheContext.staticState ? { staticMetadata: staticMetadata(cacheContext) } : {}) };
      } catch (error) {
        if (abort.signal.aborted && abort.signal.reason?.statusCode === 504) throw abort.signal.reason;
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await flushCacheWork(cacheContext);
    }
  });
}

async function handleRequest(request, channel = null) {
  if (request.operation === 'static-params') {
    return runRequestContext({ ...request, phase: 'render' }, async () => {
      const context = currentRequest();
      try { return { staticParams: await collectStaticParams(await import(pathToFileURL(request.modulePath).href), request.routePattern) }; }
      finally { await flushCacheWork(context); }
    });
  }
  if (!request.action) return renderFlight(request, null, channel);
  const outcome = await runAction(request);
  const responseHeaders = outcome.setCookies.length ? { 'set-cookie': outcome.setCookies } : {};
  if (outcome.native && outcome.actionRedirect) {
    return { body: new ArrayBuffer(0), status: 303, headers: { ...responseHeaders, location: outcome.actionRedirect.url } };
  }
  const { action, ...renderRequest } = request;
  const actionModel = { actionResult: outcome.actionResult, actionError: outcome.actionError,
    formState: outcome.formState, actionRedirect: outcome.actionRedirect };
  if (renderRequest.routingRequestHeaders && outcome.setCookies.length) {
    const original = new Headers(renderRequest.routingRequestHeaders);
    const parsed = value => new Map((value || '').split(';').map(part => { const split = part.indexOf('='); return [part.slice(0, split).trim(), part.slice(split + 1).trim()]; }).filter(([name]) => name));
    const cookies = parsed(original.get('cookie')), updated = parsed(new Headers(outcome.headers).get('cookie'));
    for (const line of outcome.setCookies) {
      const name = line.slice(0, line.indexOf('=')).trim();
      if (updated.has(name)) cookies.set(name, updated.get(name)); else cookies.delete(name);
    }
    if (cookies.size) original.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')); else original.delete('cookie');
    renderRequest.routingRequestHeaders = Object.fromEntries(original);
  }
  try {
    return await renderFlight({ ...renderRequest, mutableCookies: false, headers: outcome.headers,
      temporaryReferences: outcome.temporaryReferences, responseHeaders,
      responseStatus: outcome.failure ? 500 : 200,
      actionNotFound: outcome.actionNotFound,
      ...(outcome.native && outcome.failure ? { fallbackError: outcome.failure } : {}),
      ...(outcome.actionRedirect ? { controlModel: actionModel } : { actionModel }),
    }, null, channel);
  } catch (error) {
    error.responseHeaders = responseHeaders;
    throw error;
  }
}

const streamChannels = new Map();
const activeRequests = new Set();
const cancelledRequests = new Set();
const manifests = new Map();
const artifacts = new Map();
parentPort.on('message', async ({ id, request, type, value }) => {
  if (type === 'metadata') { manifests.set(id, value); return; }
  if (type === 'metadata-drop') { manifests.delete(id); return; }
  if (type === 'artifact') { artifacts.set(id, value); return; }
  if (type === 'artifact-drop') { artifacts.delete(id); return; }
  if (type === 'credit') { streamChannels.get(id)?.credit(); return; }
  if (type === 'cancel') {
    if (activeRequests.has(id)) cancelledRequests.add(id);
    else parentPort.postMessage({ id, type: 'settled' });
    streamChannels.get(id)?.cancel(); return;
  }
  for (const field of ['clientModules', 'actions']) {
    if (request[field + 'Id'] !== undefined) request[field] = manifests.get(request[field + 'Id']);
  }
  const channel = request.stream && (!request.action || request.action.id) ? workerStreamChannel(parentPort, id) : null;
  activeRequests.add(id);
  if (channel) streamChannels.set(id, channel);
  try {
    if (request.partialFlightId !== undefined) {
      // Resolve synchronously, before the next message can evict this ID.
      if (!artifacts.has(request.partialFlightId)) throw new Error('Unknown partial Flight artefact');
      request.partialFlight = artifacts.get(request.partialFlightId);
      delete request.partialFlightId;
    }
    if (channel) {
      await handleRequest({ ...request, renderKey: id }, channel);
      return;
    }
    const result = await handleRequest({ ...request, renderKey: id });
    parentPort.postMessage({ id, ...result }, result.body instanceof ArrayBuffer ? [result.body] : []);
  } catch (error) {
    parentPort.postMessage({ id, error: {
      message: error?.message || String(error), stack: error?.stack, digest: error?.digest, statusCode: error?.statusCode,
      retireWorker: error?.retireWorker, responseHeaders: error?.responseHeaders,
      code: error?.code, staticMode: error?.staticMode, dynamicReason: error?.dynamicReason,
    } });
  } finally {
    streamChannels.delete(id); activeRequests.delete(id);
    if (cancelledRequests.delete(id)) parentPort.postMessage({ id, type: 'settled' });
  }
});
