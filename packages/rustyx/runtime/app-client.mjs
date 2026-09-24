import React, { startTransition, useLayoutEffect } from 'react';
import { preload } from 'react-dom';
import { partialModel } from './app-partial-model.mjs';
import { PARTIAL_PREFETCH_TYPE, PARTIAL_PREFETCH_CACHE_BYTES, readPartialPrefetch, partialFlightStream } from './app-prefetch.mjs';
import { isDynamicBailout } from '../compat/dynamic-bailout.cjs';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { AppRouterProvider } from '../compat/app-context.cjs';
import { appContent } from './app-content.mjs';
import { configureServerActions } from './action-client.mjs';
import { getNavigationControl } from '../compat/app-navigation-boundary.cjs';
import { readRewriteHeader, readRewriteMarker } from '../compat/rewrite.cjs';
import { flightResponseURL, publicNavigationURL, isApplicationURL } from './client-navigation.mjs';
import { normalizeBasePath, removeBasePath } from '../compat/paths.cjs';
import GlobalErrorBoundary, { DefaultGlobalError, GlobalErrorTrigger } from '../compat/app-global-error-boundary.cjs';
import { loadBeforeInteractive } from '../compat/script-loader.cjs';

const PREFETCH_LIMIT = 8;
const PREFETCH_LIFETIME = 30_000;
let application;
let strictMode = true;

function loadClientModule(source) {
  if (typeof source === 'function') return source();
  // Keep the argument separate: esbuild splits import(condition ? a : b)
  // into two imports and moves webpackIgnore outside both calls.
  const url = typeof source === 'string' ? source : source.browserModule;
  return import(/* webpackIgnore: true */ url);
}

// React Flight's webpack adapter only needs these two operations. The compiler
// supplies ESM import functions so React and application contexts stay shared.
export function installFlightModuleLoader(clientModules) {
  const loaded = new Map();
  const pending = new Map();
  const previousRequire = globalThis.__webpack_require__;
  const previousLoad = globalThis.__webpack_chunk_load__;
  globalThis.__webpack_require__ = id => {
    if (loaded.has(id)) return loaded.get(id);
    if (!Object.hasOwn(clientModules, id) && previousRequire) return previousRequire(id);
    throw new Error(`Client module ${id} has not been loaded`);
  };
  globalThis.__webpack_require__.u = id => {
    const source = clientModules[id];
    return typeof source === 'string' ? source : source?.browserModule || String(id);
  };
  globalThis.__webpack_get_script_filename__ = id => globalThis.__webpack_require__.u(id);
  globalThis.__webpack_chunk_load__ = id => {
    if (loaded.has(id)) return Promise.resolve();
    if (pending.has(id)) return pending.get(id);
    if (!Object.hasOwn(clientModules, id)) {
      if (previousLoad) return previousLoad(id);
      return Promise.reject(new Error(`Unknown Rustyx client module ${id}`));
    }
    const source = clientModules[id];
    const promise = Promise.resolve().then(() => loadClientModule(source))
      .then(module => { loaded.set(id, module); pending.delete(id); }, error => {
        pending.delete(id);
        throw error;
      });
    pending.set(id, promise);
    return promise;
  };
  return {
    async updateModules(nextModules) {
      const ids = [...loaded.keys()].filter(id => Object.hasOwn(nextModules, id));
      clientModules = nextModules;
      await Promise.all(ids.map(async id => {
        const source = clientModules[id];
        const module = await loadClientModule(source);
        loaded.set(id, module);
      }));
      for (const id of loaded.keys()) if (!Object.hasOwn(nextModules, id)) loaded.delete(id);
    },
  };
}

function embeddedFlight() {
  const queue = globalThis.__RUSTYX_FLIGHT_STREAM__;
  if (queue) {
    let closed = false;
    let onComplete;
    return new ReadableStream({
      start(controller) {
        const push = value => {
          if (closed) return;
          if (value === null) {
            closed = true;
            document.removeEventListener('DOMContentLoaded', onComplete);
            controller.close();
          } else {
            const binary = atob(value);
            controller.enqueue(Uint8Array.from(binary, character => character.charCodeAt(0)));
          }
        };
        onComplete = () => {
          if (!closed) { closed = true; controller.error(new Error('The initial Flight stream ended before completion')); }
        };
        const initial = queue.splice(0);
        queue.push = push;
        for (const value of initial) push(value);
        if (!closed) {
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onComplete, { once: true });
          else queueMicrotask(onComplete);
        }
      },
      cancel() { closed = true; document.removeEventListener('DOMContentLoaded', onComplete); queue.push = () => {}; },
    });
  }
  const element = document.getElementById('__RUSTYX_FLIGHT__');
  if (!element) throw new Error('Rustyx App Router Flight payload is missing');
  const binary = atob(element.textContent.trim());
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  element.remove();
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

function NormalStyles({ css, fonts }) {
  const [styles, setStyles] = React.useState([]);
  useLayoutEffect(() => {
    for (const font of fonts || []) preload(font.href, { as: 'font', type: font.type, crossOrigin: 'anonymous' });
    // Fatal global renders never commit this branch. Wait for a successful
    // normal/local-error mount, then restore sheets omitted from its empty SSR
    // document. Existing plain SSR links are already loaded and need no copy.
    const loaded = new Set([...document.querySelectorAll('link[rel="stylesheet"]')].map(node => node.href));
    const missing = (css || []).filter(href => !loaded.has(new URL(href, window.location.href).href));
    if (missing.length) setStyles(current => [...new Set([...current, ...missing])]);
  }, [css, fonts]);
  return styles.map(href => React.createElement('link', { key: href, href, rel: 'stylesheet', precedence: 'rustyx-app' }));
}

function AppRoot({ model, controller, committed, url, globalErrorComponent, globalErrorCss }) {
  const [hydrated, setHydrated] = React.useState(false);
  const previewDynamic = React.useCallback(() => { throw model.partialPreview.suspended; }, [model.partialPreview]);
  useLayoutEffect(() => {
    if (process.env.NODE_ENV === 'development' && model.instantDiagnostics?.length) globalThis.__RUSTYX_DEV__?.reportError(Object.assign(new Error(model.instantDiagnostics.join('\n')), { digest: 'RUSTYX_INSTANT_BLOCKING' }));
  }, [model.instantDiagnostics]);
  useLayoutEffect(() => { setHydrated(true); committed?.(); }, [model, committed]);
  // Cached Flight describes a canonical path without one visitor's query.
  // Preserve its server snapshot for hydration, then expose the actual browser
  // URL. On navigation, update it in the same render as the new component tree.
  const location = hydrated ? new URL(url || window.location.href) : null;
  const router = location ? { ...model.router, pathname: removeBasePath(location.pathname, model.router.basePath || ''), search: location.search,
    ...(model.rewrite ? { pageSearch: new URL(model.rewrite.url, location).search, params: model.rewrite.params } : {}),
  } : model.router;
  return React.createElement(AppRouterProvider, { router, controller, ...(model.partialPreview ? { prerenderSearch: previewDynamic, ...(model.partialPreview.unknownParams ? { prerenderParams: previewDynamic } : {}) } : {}) },
    React.createElement(GlobalErrorBoundary, { component: globalErrorComponent, css: globalErrorCss, resetKey: model },
      model.globalError ? React.createElement(GlobalErrorTrigger, { error: model.globalError })
        : appContent(model.tree, { layoutCache: model.layoutCache || null, styles: React.createElement(NormalStyles, { css: model.css, fonts: model.fonts }) })));
}

function prepareLayoutCache(model, previous) {
  if (!model.routing || model.layoutCache) return model;
  const active = new Set(Object.keys(model.routing.slots));
  model.layoutCache = {
    slots: Object.fromEntries(Object.entries(previous?.layoutCache?.slots || {}).filter(([key]) => active.has(key))),
    segments: Object.fromEntries(Object.entries(previous?.layoutCache?.segments || {}).filter(([key]) => [...active].some(slot => slot.startsWith(`${key}::`)))),
  };
  return model;
}

function AppView(props) {
  // The custom fallback still has router context. A separate final boundary
  // catches errors in that fallback or in the router/provider itself.
  return React.createElement(GlobalErrorBoundary, { component: DefaultGlobalError, resetKey: props.model,
    refresh: props.controller.refresh }, React.createElement(AppRoot, props));
}

function appView(props) {
  return React.createElement(strictMode ? React.StrictMode : React.Fragment, null, React.createElement(AppView, props));
}

function historyState(key, scroll, routing) {
  const state = window.history.state;
  return { ...(state && typeof state === 'object' ? state : {}), __rustyx: { key, scroll, ...(routing ? { routing } : {}) } };
}

function scrollToTarget(url, saved) {
  if (saved) { window.scrollTo(saved[0], saved[1]); return; }
  if (url.hash) {
    let name = url.hash.slice(1);
    try { name = decodeURIComponent(name); } catch { /* A literal malformed escape can be an element ID. */ }
    const anchor = document.getElementById(name) || document.getElementsByName(name)[0];
    if (anchor) { anchor.scrollIntoView(); return; }
  }
  window.scrollTo(0, 0);
}

function assertModel(model) {
  if (!model || typeof model !== 'object' || model.routingInvalid || !Object.hasOwn(model, 'tree') ||
      typeof model.router?.pathname !== 'string') throw new Error('Invalid Rustyx Flight response');
  return model;
}

async function startApp({ clientModules = {}, basePath = '', trailingSlash = false, skipTrailingSlashRedirect = false, globalErrorId, globalErrorCss = [], strictMode: enabledStrictMode = true, cacheComponents = false } = {}) {
  strictMode = enabledStrictMode;
  await loadBeforeInteractive();
  basePath = normalizeBasePath(basePath);
  const navigationUrl = href => publicNavigationURL(href, window.location.href, basePath, { trailingSlash, skipTrailingSlashRedirect });
  const moduleLoader = installFlightModuleLoader(clientModules);
  const globalErrorComponent = globalErrorId ? React.lazy(async () => {
    await globalThis.__webpack_chunk_load__(globalErrorId);
    return { default: globalThis.__webpack_require__(globalErrorId).default };
  }) : DefaultGlobalError;
  // The Flight adapter reads __webpack_require__.u during module evaluation.
  const flightClient = await import('react-server-dom-webpack/client.browser');
  const { createFromFetch, createFromReadableStream, createServerReference, createTemporaryReferenceSet, encodeReply } = flightClient.default || flightClient;
  let root;
  let actionQueue = Promise.resolve();
  configureServerActions({ createServerReference, callServer });
  const flightOptions = { replayConsoleLogs: false, callServer };
  let initialModel;
  try { initialModel = assertModel(await createFromReadableStream(embeddedFlight(), flightOptions)); }
  catch (error) {
    initialModel = { tree: null, globalError: error, router: {
      pathname: removeBasePath(window.location.pathname, basePath), search: window.location.search,
    } };
  }
  initialModel.router.basePath = basePath;
  prepareLayoutCache(initialModel);
  const initialRewrite = readRewriteMarker(document);
  if (initialRewrite) initialModel.rewrite = initialRewrite;
  let currentUrl = new URL(window.location.href);
  let currentRouting = initialModel.routing;
  let currentModel = initialModel;
  const historyModels = new Map();
  let currentKey = window.history.state?.__rustyx?.key || 0;
  let nextKey = currentKey + 1;
  let navigation = 0;
  let activeRequest;
  const prefetches = new Map();
  const partialSegments = new Map();
  let segmentBytes = 0;

  if (currentRouting) historyModels.set(currentKey, initialModel);
  window.history.replaceState(historyState(currentKey, [window.scrollX, window.scrollY], currentRouting), '', currentUrl.href);
  window.history.scrollRestoration = 'manual';

  function saveScroll() {
    // popstate has already changed location; never overwrite its destination.
    if (window.location.href === currentUrl.href) {
      window.history.replaceState(historyState(currentKey, [window.scrollX, window.scrollY], currentRouting), '', currentUrl.href);
    }
  }

  async function requestFlight(url, signal, routing = currentRouting, onPartial) {
    const exported = window.__RUSTYX_STATIC_EXPORT__ === true;
    const target = exported ? new URL(basePath + '/_rustyx/flight' + (url.pathname.slice(basePath.length).replace(/\/$/, '') || '') + '/index.txt', url) : url;
    const response = await fetch(target.href, {
      headers: { RSC: '1', Accept: 'text/x-component', ...(routing ? { 'x-rustyx-router-state': encodeURIComponent(JSON.stringify(routing)) } : {}) },
      credentials: 'same-origin',
      signal,
    });
    let destination;
    try { destination = exported ? url : flightResponseURL(response, url); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    if (exported ? !response.ok : !response.headers.get('content-type')?.toLowerCase().startsWith('text/x-component')) {
      await response.body?.cancel();
      throw new Error('The navigation destination requires a document request');
    }
    onPartial?.(response, destination);
    const model = assertModel(await createFromFetch(Promise.resolve(response), flightOptions));
    model.router.basePath = basePath;
    const rewrite = readRewriteHeader(response);
    if (rewrite) model.rewrite = rewrite;
    return { model, url: destination };
  }

  async function requestPartial(url, signal) {
    const response = await fetch(url.href, { credentials: 'same-origin', signal,
      headers: { RSC: '1', Accept: PARTIAL_PREFETCH_TYPE, 'x-rustyx-prefetch': '1',
        ...(partialSegments.size ? { 'x-rustyx-prefetch-known': [...partialSegments.keys()].join(',') } : {}) } });
    const destination = flightResponseURL(response, url);
    if (!response.headers.get('content-type')?.startsWith(PARTIAL_PREFETCH_TYPE)) {
      await response.body?.cancel();
      return null;
    }
    const value = await readPartialPrefetch(response);
    let segment = partialSegments.get(value.id);
    if (!segment && value.flight) {
      const bytes = value.flight.length;
      while (partialSegments.size >= 8 || segmentBytes + bytes > PARTIAL_PREFETCH_CACHE_BYTES) {
        const id = partialSegments.keys().next().value;
        if (id === undefined) return null;
        segmentBytes -= partialSegments.get(id).bytes;
        partialSegments.delete(id);
      }
      const model = createFromReadableStream(partialFlightStream(value.flight), flightOptions);
      segment = { bytes, model };
      partialSegments.set(value.id, segment);
      segmentBytes += bytes;
    }
    if (!segment) return null; // A concurrent eviction is a harmless prefetch miss.
    // No visitor data is decoded here. Explicit postponed errors become pending
    // boundaries until the navigation's independently authorized Flight arrives.
    const suspended = new Promise(() => {});
    const model = partialModel(assertModel(await segment.model), { keyMap: new Map(value.keys), suspended });
    model.router = { ...value.router, basePath };
    model.partialPreview = { unknownParams: value.unknownParams, suspended };
    return { model, id: value.id, url: destination, partial: true };
  }

  function dropPrefetch(key, invalidate = false) {
    const entry = prefetches.get(key);
    if (!entry) return;
    prefetches.delete(key);
    clearTimeout(entry.timer);
    if (invalidate) {
      entry.abort.abort();
      entry.onInvalidate?.();
    }
  }

  function invalidatePrefetches() {
    partialSegments.clear(); segmentBytes = 0;
    for (const key of prefetches.keys()) dropPrefetch(key, true);
  }

  function callServer(id, args) {
    if (!root) return Promise.reject(new Error('Server Actions cannot run during initial rendering'));
    const token = ++navigation;
    const target = new URL(window.location.href);
    activeRequest?.abort();
    activeRequest = undefined;
    // Mutations are dispatched in order, including Set-Cookie effects required
    // by a subsequent action. Capture their route priority when invoked: a
    // queued action must not cancel a newer user navigation when it starts.
    const result = actionQueue.then(() => dispatchAction(id, args, token, target));
    actionQueue = result.catch(() => {});
    return result;
  }

  async function dispatchAction(id, args, token, target) {
    invalidatePrefetches();
    const temporaryReferences = createTemporaryReferenceSet();
    const body = await encodeReply(args, { temporaryReferences });
    const response = await fetch(target.href, {
      method: 'POST',
      headers: { 'Next-Action': id, RSC: '1', Accept: 'text/x-component', ...(currentRouting ? { 'x-rustyx-router-state': encodeURIComponent(JSON.stringify({ ...currentRouting, refresh: true })) } : {}) },
      credentials: 'same-origin',
      // RPC redirects arrive as Flight data. Never replay a mutation through an
      // unexpected HTTP 307/308 or redirect an authenticated POST off origin.
      redirect: 'error',
      body,
    });
    invalidatePrefetches();
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/x-component')) {
      await response.body?.cancel();
      throw new Error(`Server Action request failed (${response.status})`);
    }
    const model = await createFromFetch(Promise.resolve(response), { ...flightOptions, temporaryReferences });
    if (model?.routingInvalid || (model?.rootLayout && currentModel.rootLayout && model.rootLayout !== currentModel.rootLayout)) {
      if (token === navigation) window.location.replace(target.href);
      return model.actionResult;
    }
    if (model?.actionRedirect) {
      const destination = navigationUrl(model.actionRedirect.url);
      if (token === navigation) await navigate(destination, { replace: model.actionRedirect.type === 'replace' });
      return model.actionResult;
    }
    if (model && Object.hasOwn(model, 'tree') && token === navigation) {
      assertModel(model);
      model.router.basePath = basePath;
      const rewrite = readRewriteHeader(response);
      if (rewrite) model.rewrite = rewrite;
      prepareLayoutCache(model, currentModel);
      currentRouting = model.routing;
      currentModel = model;
      if (currentRouting) historyModels.set(currentKey, model);
      startTransition(() => root.render(appView({ model, controller, url: target.href, globalErrorComponent, globalErrorCss })));
    }
    if (model?.actionError) {
      const error = new Error(model.actionError.message || 'The Server Action failed');
      if (model.actionError.digest !== undefined) error.digest = model.actionError.digest;
      throw error;
    }
    // Flight's JSON reviver removes object fields encoded as $undefined. A
    // successful void action therefore has an updated tree but no own result.
    if (!model || typeof model !== 'object' || (!Object.hasOwn(model, 'actionResult') && !Object.hasOwn(model, 'tree'))) {
      throw new Error('The Server Action response did not contain a result');
    }
    return model.actionResult;
  }

  async function navigate(href, { replace = false, scroll = true, pop = false, savedScroll, savedRouting, refresh = false } = {}) {
    const target = navigationUrl(href);
    if (!isApplicationURL(target, window.location.origin, basePath)) {
      if (replace) window.location.replace(target.href);
      else window.location.assign(target.href);
      return;
    }
    const token = ++navigation;
    activeRequest?.abort();
    activeRequest = undefined;
    saveScroll();

    function updateHistory(destination) {
      if (!pop && !refresh) {
        if (!replace) currentKey = nextKey++;
        const position = scroll ? [0, 0] : [window.scrollX, window.scrollY];
        window.history[replace ? 'replaceState' : 'pushState'](historyState(currentKey, position, currentRouting), '', destination.href);
      } else if (pop) {
        currentKey = window.history.state?.__rustyx?.key ?? nextKey++;
      }
      if ((pop || refresh) && destination.href !== window.location.href) {
        window.history.replaceState(historyState(currentKey, savedScroll || [0, 0], currentRouting), '', destination.href);
      }
      currentUrl = destination;
    }

    if (!refresh && target.pathname === currentUrl.pathname && target.search === currentUrl.search && target.hash !== currentUrl.hash) {
      updateHistory(target);
      if (scroll) scrollToTarget(target, savedScroll);
      return;
    }

    try {
      const cacheKey = `${target.origin}${target.pathname}${target.search}`;
      const prefetched = !refresh && prefetches.get(cacheKey);
      let result;
      let historyUpdated = false;
      const historyModel = pop && savedRouting && historyModels.get(window.history.state?.__rustyx?.key);
      if (historyModel) result = { model: historyModel, url: target };
      else if (prefetched) {
        activeRequest = prefetched.abort;
        dropPrefetch(cacheKey);
        result = await prefetched.promise;
        if (result && !result.partial) {
          result = { ...result, url: new URL(result.url.href) };
          if (!result.url.hash) result.url.hash = target.hash;
        } else {
          const preview = result;
          const abort = new AbortController();
          activeRequest = abort;
          result = await requestFlight(target, abort.signal, currentRouting, (response, destination) => {
            if (!preview || token !== navigation || response.headers.get('x-rustyx-ppr-id') !== preview.id ||
                (preview.model.rootLayout && currentModel.rootLayout && preview.model.rootLayout !== currentModel.rootLayout)) return;
            // Auth, middleware and rewrites ran again. A changed target or a
            // redirect cannot reveal an obsolete protected prefetched segment.
            if (destination.pathname !== preview.url.pathname || destination.search !== preview.url.search) return;
            updateHistory(destination); historyUpdated = true;
            startTransition(() => root.render(appView({ model: preview.model, controller, url: destination.href, globalErrorComponent, globalErrorCss })));
          });
        }
      } else {
        const abort = new AbortController();
        activeRequest = abort;
        result = await requestFlight(target, abort.signal, pop && savedRouting ? { ...savedRouting, restore: true } : refresh && currentRouting ? { ...currentRouting, refresh: true } : currentRouting);
      }
      if (token !== navigation) return;
      if (!isApplicationURL(result.url, window.location.origin, basePath)) throw new Error('The navigation destination requires a document request');
      if (result.model.rootLayout && currentModel.rootLayout && result.model.rootLayout !== currentModel.rootLayout) throw new Error('A different root layout requires a document request');
      prepareLayoutCache(result.model, currentModel);
      currentRouting = result.model.routing;
      currentModel = result.model;
      if (currentRouting) invalidatePrefetches();
      if (!historyUpdated) updateHistory(result.url);
      if (currentRouting) historyModels.set(currentKey, currentModel);
      while (historyModels.size > 16) historyModels.delete(historyModels.keys().next().value);
      const committed = () => {
        if (token === navigation && scroll && !refresh) scrollToTarget(result.url, savedScroll);
      };
      startTransition(() => root.render(appView({ model: result.model, controller, committed, url: result.url.href, globalErrorComponent, globalErrorCss })));
    } catch (error) {
      if (token !== navigation || error?.name === 'AbortError') return;
      // Pages Router routes, public files, and unavailable Flight endpoints use
      // a normal document navigation, including the browser's redirect handling.
      if (replace || pop || refresh) window.location.replace(target.href);
      else window.location.assign(target.href);
    }
  }

  const controller = {
    partialPrefetch: cacheComponents,
    push: (href, options) => { void navigate(navigationUrl(href), options); },
    replace: (href, options) => { void navigate(navigationUrl(href), { ...options, replace: true }); },
    refresh: () => {
      invalidatePrefetches();
      void navigate(new URL(window.location.href), { refresh: true });
    },
    back: () => { saveScroll(); window.history.back(); },
    forward: () => { saveScroll(); window.history.forward(); },
    prefetch(href, options = {}) {
      const target = navigationUrl(href);
      if (!isApplicationURL(target, window.location.origin, basePath)) return;
      target.hash = '';
      const key = target.href;
      if (prefetches.has(key)) return;
      while (prefetches.size >= PREFETCH_LIMIT) dropPrefetch(prefetches.keys().next().value, true);
      const abort = new AbortController();
      const entry = { abort, onInvalidate: options.onInvalidate };
      entry.promise = cacheComponents && !window.__RUSTYX_STATIC_EXPORT__ ? requestPartial(target, abort.signal) : requestFlight(target, abort.signal);
      // A failed speculative fetch must never produce an unhandled rejection.
      entry.promise.catch(() => { if (prefetches.get(key) === entry) dropPrefetch(key, true); });
      entry.timer = setTimeout(() => dropPrefetch(key, true), PREFETCH_LIFETIME);
      prefetches.set(key, entry);
    },
  };

  const initialView = appView({ model: initialModel, controller, globalErrorComponent, globalErrorCss });
  const rootOptions = {
    formState: initialModel.formState ?? null,
    onCaughtError(error) {
      if (!getNavigationControl(error)) {
        console.error(error);
        if (process.env.NODE_ENV === 'development') globalThis.__RUSTYX_DEV__?.reportError(error);
      }
    },
    onRecoverableError(error) {
      if (!getNavigationControl(error) && !isDynamicBailout(error) && !isDynamicBailout(error?.cause)) console.error(error);
    },
  };
  if (document.documentElement.id === '__rustyx_error__') {
    // A fatal server render intentionally sends an empty document. Its Flight
    // failure is retried on the client, so there is no server tree to hydrate.
    root = createRoot(document, rootOptions);
    root.render(initialView);
  } else root = hydrateRoot(document, initialView, rootOptions);
  window.addEventListener('popstate', event => {
    void navigate(new URL(window.location.href), { pop: true, savedScroll: event.state?.__rustyx?.scroll, savedRouting: event.state?.__rustyx?.routing });
  });
  window.addEventListener('pagehide', saveScroll);
  let scrollFrame;
  window.addEventListener('scroll', () => {
    if (scrollFrame !== undefined) return;
    scrollFrame = requestAnimationFrame(() => { scrollFrame = undefined; saveScroll(); });
  }, { passive: true });
  return { root, router: controller, ...(process.env.NODE_ENV === 'development' ? {
    devPrepare: options => moduleLoader.updateModules(options.clientModules),
    devCommit: () => controller.refresh(),
  } : {}) };
}

export function bootstrapApp(options) {
  if (process.env.NODE_ENV === 'development' && options.dev && globalThis.__RUSTYX_DEV__) {
    return globalThis.__RUSTYX_DEV__.bootstrap('app', options, () => startApp(options));
  }
  application ||= startApp(options);
  return application;
}
