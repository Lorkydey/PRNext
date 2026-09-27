import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import Router, { RouterProvider, useRouter, installPagesRouter } from '../compat/router.cjs';
import { createPagesNavigation, pageRouterSnapshot } from './pages-navigation.mjs';
import { HeadProvider } from '../compat/head.cjs';
import { preloadReady } from '../compat/dynamic.cjs';
import { readRewriteMarker, readRewriteHeader } from '../compat/rewrite.cjs';
import { pageDataRedirectURL } from './client-navigation.mjs';
import { addBasePath, removeBasePath } from '../compat/paths.cjs';
import ErrorPage from '../compat/error.cjs';
import { ScriptContext } from '../compat/script-context.cjs';
import { initScriptLoader } from '../compat/script-loader.cjs';

const MAX_DATA_BYTES = 16 * 1024 * 1024;

export function pageDataURL(buildId, location, basePath = '') {
  if (typeof buildId !== 'string' || !buildId) throw new Error('Missing PRNext build ID');
  const url = new URL(location);
  const pathname = removeBasePath(url.pathname, basePath).replace(/\/+$/, '') || '/';
  // /index.json represents the root; literal /index routes need one escape prefix.
  const firstSegment = decodeURIComponent(pathname.split('/')[1] || '');
  const asset = pathname === '/' ? '/index' : firstSegment === 'index' ? `/index${pathname}` : pathname;
  return `${url.origin}${addBasePath(`/_prnext/data/${encodeURIComponent(buildId)}${asset}.json`, basePath)}${url.search}`;
}

async function readPageData(response, limit = MAX_DATA_BYTES, { discard = false, signal } = {}) {
  const error = !response.ok && (discard || response.status !== 404)
    ? new Error(`Page data request failed (${response.status})`)
    : !discard && !response.headers.get('content-type')?.toLowerCase().includes('application/json')
      ? new Error('Invalid page data response') : null;
  if (error) {
    await response.body?.cancel(error).catch(() => {});
    throw error;
  }
  signal?.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) {
    if (discard) return { data: null, bytes: 0 };
    throw new Error('Empty page data response');
  }
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const decoder = discard ? null : new TextDecoder();
  let length = 0;
  let source = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Page data exceeds the response limit');
      if (decoder) source += decoder.decode(value, { stream: true });
    }
    if (discard) return { data: null, bytes: length };
    source += decoder.decode();
    return { data: JSON.parse(source), bytes: length };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export async function readPageDataResponse(response, visibleURL, {
  maxBytes = MAX_DATA_BYTES, includeBytes = false, fetcher = globalThis.fetch, signal, requestURL = visibleURL,
} = {}) {
  try {
    let legacy = false;
    for (let redirects = 0; response.headers.get('x-prnext-legacy-navigation') === '1'; redirects++) {
      legacy = true;
      const location = response.headers.get('x-prnext-legacy-location');
      if (location === null) break;
      if (!response.ok) throw new Error(`Page data request failed (${response.status})`);
      if (redirects === 20) throw new Error('Too many legacy page redirects');
      // Location is an HTTP URL relative to the actual data response, not the
      // browser's visible route. Only the final response may supply a rewrite.
      const target = new URL(location, response.url || requestURL);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported navigation protocol');
      await response.body?.cancel();
      signal?.throwIfAborted();
      response = await fetcher(target.href, { credentials: 'same-origin', redirect: 'follow', signal,
        headers: { accept: 'application/json', 'x-nextjs-data': '1', 'x-prnext-navigation': '1' } });
      requestURL = target.href;
    }
    if (legacy && !response.ok && (response.status < 300 || response.status >= 400)) throw new Error(`Page data request failed (${response.status})`);
    const redirect = pageDataRedirectURL(response, visibleURL);
    if (redirect) {
      await response.body?.cancel();
      return { redirect: redirect.href };
    }
    // Legacy middleware probes run server hooks for their effects. Their body
    // does not provide props: the client hook runs after routing is resolved.
    const result = await readPageData(response, maxBytes, { discard: legacy, signal });
    const rewrite = readRewriteHeader(response) || result.data?.__PRNEXT_ROUTER__?.rewrite;
    return { data: result.data, rewrite, ...(legacy ? { legacy: true } : {}), ...(includeBytes ? { bytes: result.bytes,
      cacheable: !legacy && !rewrite && !/(?:^|[,\s])(?:no-store|private)(?:[,\s=]|$)/i.test(response.headers.get('cache-control') || ''),
    } : {}) };
  } catch (error) {
    await response.body?.cancel(error).catch(() => {});
    throw error;
  }
}

function PageEntry({ Page, App, data }) {
  const router = useRouter();
  return App
    ? React.createElement(App, { ...data.appProps, Component: Page, pageProps: data.props, router })
    : React.createElement(Page, data.props);
}

class PagesErrorBoundary extends React.Component {
  state = { view: this.props.view, error: null };
  static getDerivedStateFromProps(props, state) {
    return props.view === state.view ? null : { view: props.view, error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) {
    if (process.env.NODE_ENV === 'development') globalThis.__PRNEXT_DEV__?.reportError(error);
    void this.props.reportError(error, this.props.view);
  }
  render() {
    return this.state.error ? React.createElement(ErrorPage, { statusCode: this.state.error.statusCode }) : this.props.children;
  }
}

function PagesRoot({ state, committed, reportError, strictMode }) {
  const [hydrated, setHydrated] = React.useState(false);
  React.useLayoutEffect(() => { setHydrated(true); committed?.(); }, [state, committed]);
  // Static HTML needs the visible query once after hydration. Subsequent
  // navigation snapshots already distinguish href's query from the visible as URL.
  const router = hydrated && !state.clientSnapshot ? pageRouterSnapshot(state.router, new URL(window.location.href), new URL(window.location.href), state.rewrite || state.router.rewrite) : state.router;
  return React.createElement(RouterProvider, { router, managed: true },
    React.createElement(HeadProvider, { restoreDefaults: true },
      React.createElement(ScriptContext.Provider, { value: { appDir: false, ssr: !hydrated } },
        React.createElement(PagesErrorBoundary, { view: state, reportError }, React.createElement(PageEntry, { Page: state.Page, App: state.App, data: state })))));
}

function pagesView(props) {
  return React.createElement(props.strictMode ? React.StrictMode : React.Fragment, null, React.createElement(PagesRoot, props));
}

let application;
async function startPages({ Page, App, pattern, manifestUrl, basePath = '', trailingSlash = false, skipTrailingSlashRedirect = false, assetBase, strictMode = false }) {
  const data = window.__PRNEXT_DATA__;
  if (!data?.router || !data.props) throw new Error('Missing PRNext page data');
  const rewrite = readRewriteMarker(document);
  const initial = { ...data, router: { ...data.router, basePath, trailingSlash, skipTrailingSlashRedirect }, Page, App, ...(rewrite ? { rewrite } : {}) };
  let buildId = data.buildId;
  const container = document.getElementById('__prnext');
  if (!container) throw new Error('Missing PRNext page root');
  const scripts = document.getElementById('__PRNEXT_SCRIPT_LOADER__');
  initScriptLoader(scripts ? JSON.parse(scripts.textContent) : []);
  scripts?.remove();
  await preloadReady(data.dynamicIds || []);
  let root;
  const controller = createPagesNavigation({ initial, initialRoute: { pattern: pattern || data.router.pathname }, manifestUrl, basePath, trailingSlash, skipTrailingSlashRedirect, assetBase,
    events: Router.events,
    commit(state) { return new Promise(resolve => { root.render(pagesView({ state, strictMode, committed: resolve, reportError: controller.reportRenderError })); }); },
    async readData(url, signal, { speculative, fetcher }) {
      const abort = new AbortController();
      const cancel = () => abort.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const timer = setTimeout(() => abort.abort(new Error('Page data request timed out')), 30_000);
      try {
        const requestURL = pageDataURL(buildId, url.href, basePath);
        const response = await fetcher(requestURL, {
          credentials: 'same-origin', redirect: 'manual', signal: abort.signal,
          headers: { accept: 'application/json', 'x-nextjs-data': '1', 'x-prnext-navigation': '1', ...(speculative ? { purpose: 'prefetch' } : {}) },
        });
        return await readPageDataResponse(response, url.href, { maxBytes: speculative ? 2 * 1024 * 1024 : MAX_DATA_BYTES,
          includeBytes: speculative, fetcher, signal: abort.signal, requestURL });
      } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
    },
  });
  installPagesRouter(controller);
  let resolveHydration;
  const hydrated = new Promise(resolve => { resolveHydration = resolve; });
  root = hydrateRoot(container, pagesView({ state: initial, strictMode, committed: resolveHydration, reportError: controller.reportRenderError }));
  await hydrated;
  if (data.router.isFallback) void controller.refreshFallback();
  return { root, router: controller, ...(process.env.NODE_ENV === 'development' ? {
    async devCommit(options) {
      buildId = options.dev.buildId;
      window.__PRNEXT_DATA__.buildId = buildId;
      await controller.devRefresh({ buildId, manifestUrl: options.manifestUrl });
    },
  } : {}) };
}

export function bootstrapPages(options) {
  if (process.env.NODE_ENV === 'development' && options.dev && globalThis.__PRNEXT_DEV__) {
    return globalThis.__PRNEXT_DEV__.bootstrap('pages', options, () => startPages(options));
  }
  application ||= startPages(options);
  return application;
}
