'use client';
'use strict';

const React = require('react');
const { ReadonlyURLSearchParams } = require('./navigation.cjs');
const { ScriptContext } = require('./script-context.cjs');
const {AppRouterContext: NextAppRouterContext} = require('./next-app-router-context.cjs');
const { equalParams } = require('./navigation-values.cjs');

const AppRouterContext = React.createContext(null);
const PathnameContext = React.createContext(null);
const SearchParamsContext = React.createContext(null);
const ParamsContext = React.createContext(null);
const SNAPSHOTS = Symbol('PRNext navigation snapshots');

function unavailable() { throw new Error('App Router navigation is only available in the browser'); }
const serverRouter = Object.freeze({ push: unavailable, replace: unavailable, refresh: unavailable,
  back: unavailable, forward: unavailable, prefetch: unavailable });

// Activity keeps an immutable snapshot of its original route. Restore all
// granular contexts together with the aggregate context for hidden branches.
function RouterSnapshotProvider({ value, children }) {
  const snapshots = React.useMemo(() => value?.[SNAPSHOTS] || {
    pathname: { read: () => value?.pathname },
    search: { read: () => value?.searchParams },
    params: { read: () => value?.params },
  }, [value]);
  return React.createElement(AppRouterContext.Provider, { value },
    React.createElement(NextAppRouterContext.Provider, { value: value?.router || serverRouter },
      React.createElement(PathnameContext.Provider, { value: snapshots.pathname },
        React.createElement(SearchParamsContext.Provider, { value: snapshots.search },
          React.createElement(ParamsContext.Provider, { value: snapshots.params }, children)))));
}

function AppRouterProvider({ router, controller, nonce, children, prerenderSearch, prerenderParams }) {
  const pathname = router?.pathname || '/';
  const basePath = router?.basePath || '';
  const trailingSlash = router?.trailingSlash || false, skipTrailingSlashRedirect = router?.skipTrailingSlashRedirect || false;
  const search = router?.forceStatic ? '' : router?.search || '';
  const pageSearch = router?.forceStatic ? '' : router?.pageSearch ?? search;
  const latestParams = router?.params;
  const previousParams = React.useRef(latestParams);
  if (!equalParams(previousParams.current, latestParams)) previousParams.current = latestParams;
  const params = previousParams.current;
  const pathnameSnapshot = React.useMemo(() => ({ read() { prerenderParams?.(); return pathname; } }), [pathname, prerenderParams]);
  const searchSnapshot = React.useMemo(() => {
    const value = new ReadonlyURLSearchParams(search);
    return { read() { prerenderSearch?.(); return value; } };
  }, [search, prerenderSearch]);
  const paramsSnapshot = React.useMemo(() => ({ read() { prerenderParams?.(); return params || {}; } }), [params, prerenderParams]);
  const value = React.useMemo(() => {
    const pageSearchParams = new ReadonlyURLSearchParams(pageSearch);
    const value = {
    get pathname() { return pathnameSnapshot.read(); }, basePath, trailingSlash, skipTrailingSlashRedirect,
    get searchParams() { return searchSnapshot.read(); },
    get pageSearchParams() { prerenderSearch?.(); return pageSearchParams; },
    get params() { return paramsSnapshot.read(); },
    router: controller || serverRouter,
    };
    Object.defineProperty(value, SNAPSHOTS, { value: { pathname: pathnameSnapshot, search: searchSnapshot, params: paramsSnapshot } });
    return value;
  }, [pathnameSnapshot, searchSnapshot, paramsSnapshot, basePath, trailingSlash, skipTrailingSlashRedirect, pageSearch, controller, prerenderSearch]);
  const scripts = React.useMemo(() => ({ appDir: true, ssr: typeof window === 'undefined', nonce }), [nonce]);
  return React.createElement(RouterSnapshotProvider, { value }, React.createElement(ScriptContext.Provider, { value: scripts }, children));
}

module.exports.AppRouterContext = AppRouterContext;
module.exports.AppRouterProvider = AppRouterProvider;
module.exports.RouterSnapshotProvider = RouterSnapshotProvider;
module.exports.PathnameContext = PathnameContext;
module.exports.SearchParamsContext = SearchParamsContext;
module.exports.ParamsContext = ParamsContext;
module.exports.ReadonlyURLSearchParams = ReadonlyURLSearchParams;
