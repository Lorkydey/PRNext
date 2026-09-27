import { localePath, localizedHref } from '../compat/locale.cjs';
import { formatUrl } from '../compat/router.cjs';
import { rewriteQuery } from '../compat/rewrite.cjs';
import { normalizeBasePath, removeBasePath } from '../compat/paths.cjs';
import { publicNavigationURL, isApplicationURL } from './client-navigation.mjs';
import DefaultError from '../compat/error.cjs';
import { applicationProps, createInitialPropsRunner } from './pages-initial-props.mjs';

const PREFETCH_LIMIT = 8;
const PREFETCH_TTL = 30_000;
const ASSET_LIMIT = 2 * 1024 * 1024;
const PREFETCH_BYTES = 8 * 1024 * 1024;

export function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, signal };
    pending.abort = abortOperation.bind(null, pending);
    signal.addEventListener('abort', pending.abort, { once: true });
    if (signal.aborted) abortOperation(pending);
    Promise.resolve(promise).then(finishOperation.bind(null, pending, false), finishOperation.bind(null, pending, true));
  });
}

function abortOperation(pending) {
  finishOperation(pending, true, pending.signal?.reason || Object.assign(new Error('Route cancelled'), { cancelled: true }));
}
function finishOperation(pending, rejected, value) {
  if (!pending.resolve) return;
  const { resolve, reject, signal, abort } = pending;
  signal.removeEventListener('abort', abort);
  // User hooks and import() can remain pending after cancellation. Their
  // remaining callbacks retain this empty cell, not the navigation's promises,
  // AbortSignal or accumulated page data.
  pending.resolve = pending.reject = pending.signal = pending.abort = undefined;
  rejected ? reject(value) : resolve(value);
}

export function queryFromURL(url) {
  const query = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key)) query[key] = [...(Array.isArray(query[key]) ? query[key] : [query[key]]), value];
    else query[key] = value;
  }
  return query;
}

export function pageRouterSnapshot(router, requestURL, visibleURL, rewrite) {
  const domain = router.i18n?.domains?.find(value=>value.domain.toLowerCase()===visibleURL.host.toLowerCase());
  return { ...router, ...(router.i18n ? {domain:visibleURL.host,domainLocales:router.i18n.domains,defaultLocale:domain?.defaultLocale || router.i18n.defaultLocale,isLocaleDomain:!!domain} : {}), query: { ...(rewrite ? rewriteQuery(rewrite) : queryFromURL(requestURL)), ...router.query },
    asPath: localePath(removeBasePath(visibleURL.pathname, router.basePath || ''), router.i18n).pathname + visibleURL.search + visibleURL.hash, isReady: true, isFallback: !!router.isFallback,
    ...(rewrite ? { rewrite } : {}) };
}

export function matchPagePattern(pattern, pathname) {
  let segments;
  try { segments = pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent); }
  catch { return null; }
  if (segments.length === 1 && !segments[0]) segments = [];
  if (segments.some(segment => !segment || /[/\\\0]/.test(segment) || segment === '.' || segment === '..')) return null;
  const parts = pattern === '/' ? [] : pattern.split('/').slice(1), params = Object.create(null), rank = [];
  let index = 0;
  for (const part of parts) {
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(part);
    const catchall = /^\[\.\.\.([^\]]+)\]$/.exec(part);
    const parameter = /^\[([^\]]+)\]$/.exec(part);
    if (optional || catchall) {
      if (catchall && index === segments.length) return null;
      if (index !== segments.length) params[(optional || catchall)[1]] = segments.slice(index);
      index = segments.length; rank.push(optional ? 0 : 1);
    } else if (parameter) {
      if (index === segments.length) return null;
      params[parameter[1]] = segments[index++]; rank.push(2);
    } else {
      if (segments[index++] !== part) return null;
      rank.push(3);
    }
  }
  return index === segments.length ? { params, rank } : null;
}

export function resolvePageRoute(manifest, pathname) {
  let winner;
  for (const [routes, pages] of [[manifest.routes, true], [manifest.nonPagesRoutes || [], false]]) {
    for (const route of routes) {
      const match = matchPagePattern(route.pattern, pathname);
      if (!match) continue;
      const compare = winner && (() => {
        for (let i = 0; i < Math.max(match.rank.length, winner.rank.length); i++) {
          // An exact endpoint wins over an optional catch-all with no segment.
          const difference = (match.rank[i] ?? 4) - (winner.rank[i] ?? 4);
          if (difference) return difference;
        }
        return 0;
      })();
      if (!winner || compare > 0) winner = { ...match, route, pages };
    }
  }
  return winner;
}

async function consume(response, limit) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Unable to load a page asset'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new Error('Page asset exceeds the response limit'); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export function createPagesNavigation({ initial, initialRoute, manifestUrl, readData, commit, events,
  basePath = initial.router.basePath || '', trailingSlash = initial.router.trailingSlash || false, skipTrailingSlashRedirect = initial.router.skipTrailingSlashRedirect || false, assetBase = `${basePath}/_prnext/assets`,
  window: win = window, document: doc = document, fetch: fetcher = fetch, importModule = source => import(/* webpackIgnore: true */ source) }) {
  basePath = normalizeBasePath(basePath);
  const policy = { trailingSlash, skipTrailingSlashRedirect };
  const assets = new URL(assetBase, win.location.href);
  if (!['http:', 'https:'].includes(assets.protocol) || assets.username || assets.password || assets.search || assets.hash) throw new Error('Invalid page asset base');
  let currentURL = new URL(win.location.href), currentRequest = new URL(currentURL), current = { ...initial, route: initialRoute, clientSnapshot: true };
  current.router = pageRouterSnapshot({ ...initial.router, basePath, ...policy }, currentRequest, currentURL, initial.rewrite);
  let buildId = initial.buildId;
  const appTreePage = initial.Page, runInitialProps = createInitialPropsRunner();
  const initialErrorContext = { pathname: initial.router.pathname, query: initial.router.query,
    asPath: removeBasePath(currentURL.pathname, basePath) + currentURL.search + currentURL.hash };
  initial = undefined;
  let manifestPromise, active, renderingError, sequence = 0, beforePop = () => true;
  let currentKey = win.history.state?.__prnextPages?.key || 0, nextKey = currentKey + 1;
  const prefetches = new Map(), queue = []; let prefetchRunning = 0, prefetchBytes = 0;

  function assetURL(value) {
    const url = new URL(value, win.location.href);
    if (url.origin !== assets.origin || !url.pathname.startsWith(`${assets.pathname.replace(/\/$/, '')}/`) || url.username || url.password) throw new Error('Invalid page asset URL');
    return url.href;
  }
  function fetchAsset(value, signal) {
    const url = assetURL(value);
    return fetcher(url, { signal, mode: 'cors', credentials: new URL(url).origin === win.location.origin ? 'same-origin' : 'omit' });
  }
  const internalPath = url => removeBasePath(url.pathname, basePath);
  async function manifest() {
    manifestPromise ||= (async () => {
      if (!manifestUrl) throw new Error('This build does not contain a Pages navigation manifest');
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30_000);
      try {
        const value = JSON.parse(await consume(await fetchAsset(manifestUrl, abort.signal), ASSET_LIMIT));
        if (value.buildId !== buildId || !Array.isArray(value.routes) || value.routes.length > 10_000) throw new Error('Invalid Pages manifest');
        for (const route of [...value.routes, ...Object.values(value.errors || {}).filter(Boolean)]) {
          if (typeof route.pattern !== 'string' || !Array.isArray(route.css)) throw new Error('Invalid page route');
          assetURL(route.client); for (const css of route.css) assetURL(css);
        }
        return value;
      } finally { clearTimeout(timer); }
    })().catch(error => { manifestPromise = undefined; throw error; });
    return manifestPromise;
  }
  function targetURL(value) {
    return publicNavigationURL(value instanceof URL ? value : formatUrl(value), currentURL, basePath, policy);
  }
  function redirectURL(decoded, visible) {
    if (decoded.redirect) return new URL(decoded.redirect, visible);
    const props = decoded.data?.pageProps;
    if (!props?.__N_REDIRECT) return null;
    return props.__N_REDIRECT_BASE_PATH === false ? new URL(props.__N_REDIRECT, visible) : publicNavigationURL(props.__N_REDIRECT, visible, basePath, policy);
  }
  function targets(url, as, options = {}) {
    url = localizedHref(formatUrl(url), current.router, options.locale);
    if (as) as = localizedHref(formatUrl(as), current.router, options.locale);
    let request = targetURL(url), destination = as ? targetURL(as) : request;
    if (/\[[^/]+\]/.test(request.pathname)) {
      const params = as ? matchPagePattern(request.pathname, destination.pathname)?.params : {};
      const query = { ...params, ...queryFromURL(request) };
      const interpolated = formatUrl({ pathname: request.pathname, query, hash: request.hash });
      request = new URL(interpolated, request);
      if (/\[[^/]+\]/.test(request.pathname)) throw new Error('Missing parameters for a dynamic route');
      if (!as) destination = request;
    }
    return { request, destination };
  }
  function historyState(url, request, key, options, scroll) {
    return { ...win.history.state, __prnextPages: { key, url: request.pathname + request.search + request.hash, as: url.pathname + url.search + url.hash, options, scroll } };
  }
  function saveScroll() {
    if (win.location.href === currentURL.href) win.history.replaceState(historyState(currentURL, currentRequest, currentKey,
      win.history.state?.__prnextPages?.options || {}, [win.scrollX, win.scrollY]), '', currentURL.href);
  }
  function hard(url, replace) { win.location[replace ? 'replace' : 'assign'](url.href); }
  function scrollTo(url, saved) {
    if (saved) { win.scrollTo(...saved); return; }
    if (url.hash) {
      let id = url.hash.slice(1); try { id = decodeURIComponent(id); } catch { /* Literal malformed fragment. */ }
      const element = doc.getElementById(id) || doc.getElementsByName(id)[0];
      if (element) { element.scrollIntoView(); return; }
      if (id && id !== 'top') return;
    }
    win.scrollTo(0, 0);
  }
  async function loadCode(route, signal) {
    const module = await abortable(importModule(assetURL(route.client)), signal);
    if (!module.Page) throw new Error('Invalid page module');
    return module;
  }
  async function loadStyles(route, signal) {
    const added = [], pending = new Set();
    for (const font of route.fonts || []) {
      const href = assetURL(font.href);
      if ([...doc.querySelectorAll('link[rel="preload"][as="font"]')].some(link => link.href === href)) continue;
      const link = doc.createElement('link');
      link.rel = 'preload'; link.as = 'font'; link.href = href; link.type = font.type; link.crossOrigin = 'anonymous';
      doc.head.appendChild(link);
    }
    try {
      await Promise.all(route.css.map(source => {
        const href = assetURL(source);
        if ([...doc.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === href)) return;
        return new Promise((resolve, reject) => {
          const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = href; link.media = 'not all'; added.push(link);
          if (new URL(href).origin !== win.location.origin) link.crossOrigin = 'anonymous';
          const timer = setTimeout(() => finish(new Error('Page stylesheet timed out')), 30_000);
          const abort = () => finish(signal.reason || new Error('Page navigation cancelled'));
          function finish(error) { pending.delete(abort); clearTimeout(timer); signal.removeEventListener('abort', abort); link.onload = link.onerror = null; error ? reject(error) : resolve(); }
          link.onload = () => finish(); link.onerror = () => finish(new Error('Unable to load page stylesheet'));
          signal.addEventListener('abort', abort, { once: true });
          pending.add(abort);
          if (signal.aborted) abort(); else doc.head.appendChild(link);
        });
      }));
      return { remove() { for (const link of added) link.remove(); }, activate() { for (const link of added) link.media = ''; } };
    } catch (error) { for (const cancel of pending) cancel(); for (const link of added) link.remove(); throw error; }
  }
  async function requestData(url, signal, speculative = false) {
    return readData(url, signal, { speculative, fetcher });
  }
  function initialProps(module, context, signal, routerSnapshot = current.router) {
    return abortable(runInitialProps({ Page: module.Page, App: module.App, context,
      routerSnapshot, appTreePage }), signal);
  }
  async function loadErrorPage(map, router, destination, signal, { notFound = false, err = null, context, forceDefault = false, tolerateHookFailure = false } = {}) {
    const errors = map.localizedErrors?.[router.locale] || map.errors;
    const route = !forceDefault && (notFound ? errors?.notFound || errors?.error : errors?.error);
    const module = route ? await loadCode(route, signal) : { Page: DefaultError, App: forceDefault ? undefined : current.App };
    let result;
    if (notFound && route && route === errors?.notFound) {
      if (route.ssg) {
        const decoded = await abortable(requestData(publicNavigationURL(route.pattern, destination, basePath, policy), signal), signal);
        const props = decoded.data?.pageProps;
        if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Invalid custom 404 data');
        result = { props, appProps: applicationProps(decoded.data) };
      } else result = await initialProps(module, { err: null, pathname: route.originalPattern || route.pattern,
        asPath: destination.pathname + destination.search + destination.hash, query: router.query }, signal);
    } else {
      try {
        result = await initialProps(module, context || {
          err, pathname: notFound ? '/_error' : router.pathname,
          asPath: notFound ? destination.pathname + destination.search + destination.hash : router.asPath,
          query: router.query,
        }, signal);
      } catch (error) {
        if (!tolerateHookFailure || signal.aborted) throw error;
        result = { props: {}, appProps: {} };
      }
    }
    return { Page: module.Page, App: module.App, ...result, assetRoute: route || { css: [] }, errorKind: notFound ? 'notFound' : 'client', notFound };
  }
  function retireStyles(previous, next) {
    if (!previous) return;
    for (const css of previous.css || []) {
      if (next?.css?.includes(css)) continue;
      for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) if (link.href === assetURL(css)) link.remove();
    }
  }
  function dropPrefetch(key, abort = true) {
    const entry = prefetches.get(key); if (!entry) return;
    prefetches.delete(key); clearTimeout(entry.timer);
    prefetchBytes -= entry.bytes || 0; entry.bytes = 0;
    if (abort) entry.abort.abort(); else entry.consumed = true;
  }
  function pumpPrefetch() {
    while (prefetchRunning < 2 && queue.length) {
      const entry = queue.shift();
      if (entry.abort.signal.aborted) { entry.resolve(); continue; }
      prefetchRunning++;
      (async () => {
        const map = await abortable(manifest(), entry.abort.signal), matched = resolvePageRoute(map, internalPath(entry.request));
        if (!matched?.pages) return;
        // Fetch rather than evaluate speculative modules: fetch is cancellable,
        // whereas the browser's import() cannot cancel a blocked module request.
        await consume(await fetchAsset(matched.route.client, entry.abort.signal), ASSET_LIMIT);
        if (entry.abort.signal.aborted) return;
        // Warm browser HTTP caches without applying another page's CSS early.
        for (const css of matched.route.css) await consume(await fetchAsset(css, entry.abort.signal), ASSET_LIMIT);
        if (matched.route.ssg) {
          const decoded = await requestData(entry.request, entry.abort.signal, true);
          if (entry.abort.signal.aborted || (!prefetches.has(entry.key) && !entry.consumed) || decoded.cacheable === false) return;
          entry.data = decoded;
          if (entry.consumed) return;
          entry.bytes = decoded.bytes || 0; prefetchBytes += entry.bytes;
          while (prefetchBytes > PREFETCH_BYTES) dropPrefetch(prefetches.keys().next().value);
        }
      })().catch(() => { dropPrefetch(entry.key); }).finally(() => { prefetchRunning--; entry.resolve(); pumpPrefetch(); });
    }
  }
  function prefetch(url, as, options) {
    let request;
    try { ({ request } = targets(url, as, options)); } catch { return Promise.resolve(); }
    if (!isApplicationURL(request, win.location.origin, basePath) || process.env.NODE_ENV !== 'production') return Promise.resolve();
    request.hash = ''; const key = request.href;
    if (prefetches.has(key)) return prefetches.get(key).promise;
    while (prefetches.size >= PREFETCH_LIMIT) dropPrefetch(prefetches.keys().next().value);
    // Queued cancelled entries must not grow with an unbounded list of hovered links.
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index].abort.signal.aborted) { queue[index].resolve(); queue.splice(index, 1); }
    const entry = { key, request, abort: new AbortController() };
    entry.promise = new Promise(resolve => { entry.resolve = resolve; });
    entry.timer = setTimeout(() => dropPrefetch(key), PREFETCH_TTL);
    prefetches.set(key, entry); queue.push(entry); pumpPrefetch(); return entry.promise;
  }
  function cancelActive() {
    if (!active) return;
    active.abort.abort();
    if (!active.finished) {
      active.finished = true;
      if (!active.silent) events.emit('routeChangeError', Object.assign(new Error('Route change cancelled'), { cancelled: true }), active.asPath, { shallow: active.shallow });
    }
  }
  async function navigate(url, as, options = {}) {
    let { request, destination } = targets(url, as, options);
    if (!isApplicationURL(destination, win.location.origin, basePath) || !isApplicationURL(request, win.location.origin, basePath)) { hard(destination, options.replace); return true; }
    cancelActive(); renderingError?.abort.abort(); renderingError = undefined; saveScroll();
    const job = { id: ++sequence, abort: new AbortController(), asPath: destination.pathname + destination.search + destination.hash, shallow: !!options.shallow };
    active = job;
    const timer = setTimeout(() => job.abort.abort(new Error('Page navigation timed out')), 30_000);
    const hashOnly = destination.pathname === currentURL.pathname && destination.search === currentURL.search &&
      (destination.hash !== currentURL.hash || !!destination.hash) && !options.shallow;
    const startEvent = hashOnly ? 'hashChangeStart' : 'routeChangeStart';
    let releaseStyles;
    const isCurrent = () => active === job && !job.abort.signal.aborted;
    try {
      events.emit(startEvent, job.asPath, { shallow: job.shallow });
      const map = await abortable(manifest(), job.abort.signal);
      if (!isCurrent()) return false;
      const matched = resolvePageRoute(map, internalPath(request));
      if (matched && !matched.pages) { hard(destination, options.replace || options.pop); job.finished = true; return true; }
      const shallow = !!options.shallow && matched?.route.pattern === current.route.pattern;
      let view = current, route = current.route;
      if (!hashOnly && !shallow) {
        const cacheKey = new URL(request); cacheKey.hash = '';
        const cached = prefetches.get(cacheKey.href);
        let decoded;
        if (cached) {
          dropPrefetch(cacheKey.href, false);
          const abort = () => cached.abort.abort(); job.abort.signal.addEventListener('abort', abort, { once: true });
          try { await abortable(cached.promise, job.abort.signal); decoded = cached.data; } finally { job.abort.signal.removeEventListener('abort', abort); }
        }
        if (map.needsServerRouting === false && matched?.pages && !matched.route.ssg && !matched.route.ssp) {
          decoded = { data: { pageProps: {}, __PRNEXT_ROUTER__: { pathname: matched.route.pattern,
            query: { ...queryFromURL(request), ...matched.params }, isFallback: false } } };
        }
        for (let redirects = 0; redirects < 9; redirects++) {
          decoded ||= await abortable(requestData(request, job.abort.signal), job.abort.signal);
          if (!isCurrent()) return false;
          const redirect = redirectURL(decoded, destination);
          if (!redirect) break;
          if (redirects === 8) throw new Error('Too many page redirects');
          destination = redirect; request = new URL(destination);
          if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('Unsupported redirect protocol');
          if (!isApplicationURL(destination, win.location.origin, basePath)) { hard(destination, options.replace || options.pop); job.finished = true; return true; }
          events.emit('routeChangeStart', destination.pathname + destination.search + destination.hash, { shallow: job.shallow });
          decoded = undefined;
        }
        const routedMatch = resolvePageRoute(map, decoded.rewrite ? new URL(decoded.rewrite.url, request).pathname : internalPath(request));
        let data = decoded.data;
        if (decoded.legacy) {
          // Explicit middleware/GIP responses may contain any body, including
          // JSON resembling page data. Resolve only from the final headers and
          // manifest; a followed redirect may have lost an alias's rewrite.
          if (!routedMatch?.pages) { hard(destination, options.replace || options.pop); job.finished = true; return false; }
          const target = routedMatch.route;
          if (target.ssg || target.ssp || (!target.gip && !target.appGip)) throw new Error('Invalid legacy page data');
          data = { pageProps: {}, __PRNEXT_ROUTER__: { pathname: target.pattern, isFallback: false,
            query: { ...queryFromURL(request), ...(decoded.rewrite ? rewriteQuery(decoded.rewrite) : {}), ...routedMatch.params } } };
        }
        const snapshot = data?.__PRNEXT_ROUTER__;
        route = map.routes.find(item => (item.originalPattern || item.pattern) === snapshot?.pathname && (!snapshot.locale || item.locale === snapshot.locale)) || routedMatch?.route;
        if (!route?.client) { hard(destination, options.replace || options.pop); job.finished = true; return true; }
        if (!data?.notFound && (!snapshot || !data.pageProps || typeof data.pageProps !== 'object' || Array.isArray(data.pageProps))) throw new Error('Invalid page data');
        const router = pageRouterSnapshot({ ...current.router, ...snapshot, ...(route.locale ? {locale:route.locale} : {}), query: snapshot?.query || routedMatch?.params,
          pathname: route.originalPattern || route.pattern, basePath, isFallback: false }, request, destination, decoded.rewrite);
        let module = data.notFound ? await loadErrorPage(map, router, destination, job.abort.signal, { notFound: true })
          : await loadCode(route, job.abort.signal);
        if (!isCurrent()) return false;
        let result = data.notFound ? { props: module.props, appProps: module.appProps }
          : { props: data.pageProps, appProps: applicationProps(data) };
        if (!data.notFound && !route.ssg && !route.ssp) {
          try {
            result = await initialProps(module, { pathname: route.originalPattern || route.pattern, query: router.query,
              asPath: router.i18n ? router.asPath : destination.pathname + destination.search + destination.hash, locale:router.locale, locales:router.locales, defaultLocale:router.defaultLocale }, job.abort.signal);
          } catch (error) {
            if (!isCurrent()) return false;
            job.hookError = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'getInitialProps failed');
            // Next's route loader first asks _error for props with the failed
            // target context. Its renderer subsequently initializes the error
            // App with the original document context, unless App supplied err.
            module = await loadErrorPage(map, router, destination, job.abort.signal, { err: job.hookError,
              context: { err: job.hookError, pathname: route.originalPattern || route.pattern, query: router.query }, tolerateHookFailure: true });
            result = { props: module.props, appProps: module.appProps };
          }
          if (!isCurrent()) return false;
        }
        const assetRoute = module.assetRoute || route;
        releaseStyles = await loadStyles(assetRoute, job.abort.signal);
        view = { Page: module.Page, App: module.App, ...result, notFound: !!data.notFound,
          errorKind: module.errorKind, assetRoute, buildId, route, clientSnapshot: true, router };
      } else {
        const query = hashOnly ? current.router.query : { ...queryFromURL(request), ...matched.params };
        view = { ...current, router: { ...current.router, query, asPath: internalPath(destination) + destination.search + destination.hash } };
      }
      if (!isCurrent()) { releaseStyles?.remove(); return false; }
      const finalPath = destination.pathname + destination.search + destination.hash;
      if (!hashOnly) events.emit('beforeHistoryChange', finalPath, { shallow: job.shallow });
      if (!options.pop) {
        const replace = options.replace || destination.href === currentURL.href;
        if (!replace) currentKey = nextKey++;
        win.history[replace ? 'replaceState' : 'pushState'](historyState(destination, request, currentKey, { shallow, scroll: options.scroll },
          options.scroll === false || shallow ? [win.scrollX, win.scrollY] : [0, 0]), '', destination.href);
      } else currentKey = win.history.state?.__prnextPages?.key ?? nextKey++;
      const oldRoute = current.assetRoute || [...map.routes, ...Object.values(map.errors || {}).filter(Boolean)].find(item => item.pattern === current.route.pattern);
      current = view; currentURL = destination; currentRequest = request;
      if (job.hookError && !view.appProps?.err) {
        try {
          const result = await initialProps(view, { ...initialErrorContext, err: job.hookError }, job.abort.signal);
          if (!isCurrent()) return false;
          current = view = { ...view, ...result };
        } catch (error) {
          if (!isCurrent()) return false;
          current = view = { ...view, Page: DefaultError, App: undefined, props: { statusCode: job.hookError.statusCode }, appProps: {} };
        }
      }
      await abortable(commit(view), job.abort.signal);
      if (!isCurrent()) return false;
      releaseStyles?.activate();
      if (!shallow) retireStyles(oldRoute, view.assetRoute || route);
      if (options.scroll !== false && (!shallow || options.pop)) scrollTo(destination, options.savedScroll);
      job.finished = true; active = undefined;
      if (job.hookError) {
        job.errorRendered = true;
        events.emit('routeChangeError', job.hookError, internalPath(destination) + destination.search + destination.hash, { shallow: job.shallow });
        throw job.hookError;
      }
      events.emit(hashOnly ? 'hashChangeComplete' : 'routeChangeComplete', finalPath, { shallow: job.shallow });
      return true;
    } catch (error) {
      if (job.errorRendered) throw error;
      releaseStyles?.remove();
      if (active !== job) return false;
      job.finished = true; active = undefined;
      events.emit('routeChangeError', error, job.asPath, { shallow: job.shallow });
      hard(destination, options.replace || options.pop); return false;
    } finally { clearTimeout(timer); }
  }
  async function reportRenderError(error, failedView) {
    if (failedView !== current && (failedView.clientSnapshot || failedView.Page !== current.Page || failedView.props !== current.props)) return false;
    renderingError?.abort.abort();
    const context = { ...initialErrorContext, err: error };
    const task = { abort: new AbortController(), sequence };
    renderingError = task;
    const failed = current, forceDefault = failed.errorKind === 'client' || failed.route?.pattern === '/_error';
    const timer = setTimeout(() => task.abort.abort(new Error('Error page loading timed out')), 30_000);
    const isCurrent = () => renderingError === task && sequence === task.sequence && current === failed && !task.abort.signal.aborted;
    let styles;
    try {
      let map;
      try { map = await abortable(manifest(), task.abort.signal); }
      catch (loadError) { if (task.abort.signal.aborted) throw loadError; map = {}; }
      const module = await loadErrorPage(map, failed.router, currentURL, task.abort.signal, { err: error, context, forceDefault });
      if (!isCurrent()) return false;
      styles = await loadStyles(module.assetRoute, task.abort.signal);
      if (!isCurrent()) { styles.remove(); return false; }
      const previousStyles = failed.assetRoute || [...(map.routes || []), ...Object.values(map.errors || {}).filter(Boolean)].find(route => route.pattern === failed.route?.pattern);
      current = { ...failed, ...module, ...(forceDefault ? { App: undefined } : {}), clientSnapshot: true };
      await abortable(commit(current), task.abort.signal);
      if (renderingError !== task || sequence !== task.sequence || task.abort.signal.aborted) return false;
      styles.activate(); retireStyles(previousStyles, current.assetRoute);
      return true;
    } catch (failure) {
      styles?.remove();
      if (renderingError !== task || sequence !== task.sequence) return false;
      // A broken _error, its data hook or its chunks must not start an error loop.
      current = { ...current, Page: DefaultError, App: undefined, props: { statusCode: error?.statusCode }, errorKind: 'client', clientSnapshot: true };
      await commit(current);
      return false;
    } finally {
      clearTimeout(timer);
      if (renderingError === task) renderingError = undefined;
    }
  }
  async function refreshFallback() {
    if (!current.router.isFallback || active) return false;
    const job = { abort: new AbortController(), silent: true };
    active = job;
    const timer = setTimeout(() => job.abort.abort(new Error('Page data request timed out')), 30_000);
    let styles;
    try {
      // The initial entry already provides Page and App. In particular, an old
      // document's build must receive its data 404 before any new manifest lookup.
      const decoded = await abortable(requestData(currentRequest, job.abort.signal), job.abort.signal);
      if (active !== job || job.abort.signal.aborted) return false;
      const data = decoded.data, redirect = redirectURL(decoded, currentURL);
      if (redirect) {
        active = undefined; job.finished = true;
        return navigate(redirect, undefined, { replace: true, scroll: false });
      }
      if (!data?.notFound && (!data?.__PRNEXT_ROUTER__ || !data.pageProps || typeof data.pageProps !== 'object' || Array.isArray(data.pageProps))) throw new Error('Invalid page data');
      const router = pageRouterSnapshot({ ...current.router, ...data.__PRNEXT_ROUTER__, basePath, isFallback: false }, currentRequest, currentURL, decoded.rewrite);
      let module;
      if (data.notFound) {
        let map;
        try { map = await abortable(manifest(), job.abort.signal); }
        catch (error) { if (job.abort.signal.aborted) throw error; map = {}; }
        module = await loadErrorPage(map, router, currentURL, job.abort.signal, { notFound: true });
      }
      styles = module ? await loadStyles(module.assetRoute, job.abort.signal) : null;
      if (active !== job || job.abort.signal.aborted) { styles?.remove(); return false; }
      const previousStyles = current.assetRoute;
      current = { ...current, ...(module || { props: data.pageProps, appProps: applicationProps(data) }), notFound: !!data.notFound, router };
      await abortable(commit(current), job.abort.signal);
      if (active !== job || job.abort.signal.aborted) { styles?.remove(); return false; }
      styles?.activate(); if (module) retireStyles(previousStyles, module.assetRoute);
      return active === job && !job.abort.signal.aborted;
    } catch (error) {
      styles?.remove();
      if (active !== job) return false;
      current = { ...current, Page: DefaultError, props: { statusCode: 500 }, failed: true, router: { ...current.router, isFallback: false } };
      await commit(current);
      return false;
    } finally {
      clearTimeout(timer); job.finished = true;
      if (active === job) active = undefined;
    }
  }
  const popstate = event => {
    const state = event.state?.__prnextPages;
    if (!state) { hard(new URL(win.location.href), true); return; }
    const data = { url: state.url, as: state.as, options: state.options || {} };
    if (!beforePop(data)) return;
    void navigate(new URL(state.url, currentURL), new URL(state.as, currentURL), { ...state.options, pop: true, savedScroll: state.scroll });
  };
  let frame;
  const onScroll = () => { if (frame !== undefined) return; frame = win.requestAnimationFrame(() => { frame = undefined; saveScroll(); }); };
  const pagehide = () => { saveScroll(); active?.abort.abort(); renderingError?.abort.abort(); for (const key of prefetches.keys()) dropPrefetch(key); };
  win.history.replaceState(historyState(currentURL, currentRequest, currentKey, {}, [win.scrollX, win.scrollY]), '', currentURL.href);
  win.history.scrollRestoration = 'manual';
  win.addEventListener('popstate', popstate); win.addEventListener('scroll', onScroll, { passive: true }); win.addEventListener('pagehide', pagehide);
  return { navigate, prefetch, saveScroll, reportRenderError, snapshot: () => current.router, beforePopState(callback) { beforePop = callback; },
    ...(process.env.NODE_ENV === 'development' ? { async devRefresh(options) {
      buildId = options.buildId; manifestUrl = options.manifestUrl; manifestPromise = undefined;
      for (const key of prefetches.keys()) dropPrefetch(key);
      await navigate(currentRequest, currentURL, { replace: true, scroll: false });
    } } : {}),
    refreshFallback,
    dispose() { pagehide(); win.removeEventListener('popstate', popstate); win.removeEventListener('scroll', onScroll); win.removeEventListener('pagehide', pagehide); if (frame !== undefined) win.cancelAnimationFrame(frame); },
  };
}
