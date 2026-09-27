'use strict';

const React = require('react');
const { rewriteQuery } = require('./rewrite.cjs');
const { removeBasePath } = require('./paths.cjs');
const { localePath } = require('./locale.cjs');
const RouterContext = React.createContext(null);

function formatUrl(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') throw new TypeError('Expected a URL string or object');
  let pathname = value.pathname || '';
  const query = new URLSearchParams(typeof value.query === 'string' ? value.query : undefined);
  for (const [name, values] of Object.entries(typeof value.query === 'object' && value.query || {})) {
    for (const item of Array.isArray(values) ? values : [values]) {
      if (item !== undefined && item !== null) query.append(name, String(item));
    }
  }
  // Interpolate dynamic route names when a URL object is supplied.
  pathname = pathname.replace(/\[\[\.\.\.([^\]]+)\]\]|\[\.\.\.([^\]]+)\]|\[([^\]]+)\]/g, (match, optional, catchall, single) => {
    const name = optional || catchall || single;
    const raw = typeof value.query === 'string' ? (query.has(name) ? query.getAll(name) : undefined) : value.query?.[name];
    if (raw === undefined) return optional ? '' : match;
    query.delete(name);
    return (Array.isArray(raw) ? raw : [raw]).map(item => encodeURIComponent(String(item))).join('/');
  });
  const search = (value.search != null ? String(value.search).replace(/^\?/, '') : query.toString()).replace(/#/g, '%23');
  const hash = value.hash ? `#${String(value.hash).replace(/^#/, '')}` : '';
  let protocol = value.protocol || '';
  if (protocol && !protocol.endsWith(':')) protocol += ':';
  let host = value.host || '';
  if (!host && value.hostname) {
    host = value.hostname.includes(':') && !value.hostname.startsWith('[') ? `[${value.hostname}]` : value.hostname;
    if (value.port) host += `:${value.port}`;
  }
  if (value.auth && host) host = `${encodeURIComponent(value.auth).replace(/%3A/i, ':')}@${host}`;
  const slashes = value.slashes || (host && (!protocol || /^(?:https?|ftp|gopher|file):$/.test(protocol)));
  if (slashes && pathname && !pathname.startsWith('/')) pathname = `/${pathname}`;
  pathname = pathname.replace(/[?#]/g, encodeURIComponent);
  return `${protocol}${slashes ? '//' : ''}${host}${pathname}${search ? `?${search}` : ''}${hash}`;
}

const handlers = new Map();
const events = {
  on(type, callback) { const list = handlers.get(type) || []; list.push(callback); handlers.set(type, list); },
  off(type, callback) { const list = handlers.get(type); if (!list) return; const index = list.indexOf(callback); if (index !== -1) list.splice(index, 1); if (!list.length) handlers.delete(type); },
  emit(type, ...args) { for (const callback of [...(handlers.get(type) || [])]) callback(...args); },
};
let controller;
function installPagesRouter(value) { controller = value; }
function navigate(url, as, options, replace) {
  if (typeof window === 'undefined') throw new Error('Router navigation is only available in the browser');
  if (controller) return controller.navigate(url, as, { ...options, replace });
  const target = new URL(formatUrl(as || url), window.location.href);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported navigation protocol');
  window.location[replace ? 'replace' : 'assign'](target.href);
  return Promise.resolve(true);
}
const methods = {
  push: (url, as, options) => navigate(url, as, options, false),
  replace: (url, as, options) => navigate(url, as, options, true),
  reload: () => { if (typeof window !== 'undefined') window.location.reload(); },
  back: () => { if (typeof window !== 'undefined') { controller?.saveScroll(); window.history.back(); } },
  forward: () => { if (typeof window !== 'undefined') { controller?.saveScroll(); window.history.forward(); } },
  prefetch: (url, as, options) => controller ? controller.prefetch(url, as, options) : Promise.resolve(),
  beforePopState: callback => { if (controller) controller.beforePopState(callback); },
};
function makeRouter(snapshot) {
  return { pathname: '/', query: {}, asPath: '/', basePath: '', isReady: true, isFallback: false, isPreview: false,
    ...snapshot, route: snapshot.pathname || '/', ...methods, events };
}

function withRouteParams(query, router) {
  for (const segment of String(router?.pathname || '').split('/')) {
    const match = /^\[(?:\[)?(?:\.\.\.)?([^\]]+)\]\]?$/.exec(segment);
    if (match && router?.query && Object.hasOwn(router.query, match[1])) {
      Object.defineProperty(query, match[1], { value: router.query[match[1]], enumerable: true, configurable: true, writable: true });
    }
  }
  return query;
}

function RouterProvider({ router, children, managed = false }) {
  const [location, setLocation] = React.useState(null);
  React.useEffect(() => {
    if (managed) return;
    const refresh = () => {
      const url = new URL(window.location.href);
      const query = router?.rewrite ? rewriteQuery(router.rewrite) : Object.create(null);
      if (!router?.rewrite) for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key)) query[key] = [...(Array.isArray(query[key]) ? query[key] : [query[key]]), value];
        else query[key] = value;
      }
      withRouteParams(query, router);
      setLocation({ query, asPath: `${localePath(removeBasePath(url.pathname, router?.basePath || ''), router?.i18n).pathname}${url.search}${url.hash}` });
    };
    refresh();
    window.addEventListener('hashchange', refresh);
    window.addEventListener('popstate', refresh);
    return () => { window.removeEventListener('hashchange', refresh); window.removeEventListener('popstate', refresh); };
  }, [router, managed]);
  // A fallback data update introduces route params before the location effect reruns.
  // Keep those params in the same render as the new props and isFallback:false.
  const value = React.useMemo(() => makeRouter({ ...router, ...(managed ? {} : location),
    ...(!managed && location ? { query: withRouteParams({ ...location.query }, router) } : {}),
  }), [router, location, managed]);
  return React.createElement(RouterContext.Provider, { value }, children);
}

function useRouter() {
  const value = React.useContext(RouterContext);
  if (!value) throw new Error('useRouter must be used inside the PRNext router provider');
  return value;
}

function withRouter(Component) {
  function WithRouter(props) { return React.createElement(Component, { ...props, router: useRouter() }); }
  WithRouter.displayName = `withRouter(${Component.displayName || Component.name || 'Component'})`;
  return WithRouter;
}

const singleton = { ...methods, events };
for (const field of ['route', 'pathname', 'query', 'asPath', 'basePath', 'isReady', 'isFallback', 'isPreview', 'locale', 'locales', 'defaultLocale', 'domainLocales', 'isLocaleDomain']) {
  Object.defineProperty(singleton, field, { enumerable: true, get() {
    if (!controller) throw new Error('No router instance found. Use next/router in the browser or useRouter inside a page.');
    return makeRouter(controller.snapshot())[field];
  } });
}
module.exports = singleton;
module.exports.default = singleton;
module.exports.RouterProvider = RouterProvider;
module.exports.RouterContext = RouterContext;
module.exports.useRouter = useRouter;
module.exports.withRouter = withRouter;
module.exports.formatUrl = formatUrl;
module.exports.makeRouter = makeRouter;
module.exports.installPagesRouter = installPagesRouter;
