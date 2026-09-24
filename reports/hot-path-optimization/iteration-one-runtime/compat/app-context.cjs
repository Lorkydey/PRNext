'use client';
'use strict';

const React = require('react');
const { ReadonlyURLSearchParams } = require('./navigation.cjs');
const { ScriptContext } = require('./script-context.cjs');
const {AppRouterContext: NextAppRouterContext} = require('./next-app-router-context.cjs');

const AppRouterContext = React.createContext(null);

function unavailable() { throw new Error('App Router navigation is only available in the browser'); }
const serverRouter = Object.freeze({ push: unavailable, replace: unavailable, refresh: unavailable,
  back: unavailable, forward: unavailable, prefetch: unavailable });

function AppRouterProvider({ router, controller, nonce, children, prerenderSearch, prerenderParams }) {
  const pathname = router?.pathname || '/';
  const basePath = router?.basePath || '';
  const trailingSlash = router?.trailingSlash || false, skipTrailingSlashRedirect = router?.skipTrailingSlashRedirect || false;
  const search = router?.forceStatic ? '' : router?.search || '';
  const pageSearch = router?.forceStatic ? '' : router?.pageSearch ?? search;
  const params = router?.params;
  const value = React.useMemo(() => {
    const searchParams = new ReadonlyURLSearchParams(search);
    const pageSearchParams = new ReadonlyURLSearchParams(pageSearch);
    return {
    get pathname() { prerenderParams?.(); return pathname; }, basePath, trailingSlash, skipTrailingSlashRedirect,
    get searchParams() { prerenderSearch?.(); return searchParams; },
    get pageSearchParams() { prerenderSearch?.(); return pageSearchParams; },
    get params() { prerenderParams?.(); return params || {}; },
    router: controller || serverRouter,
    };
  }, [pathname, basePath, trailingSlash, skipTrailingSlashRedirect, search, pageSearch, params, controller, prerenderSearch, prerenderParams]);
  const scripts = React.useMemo(() => ({ appDir: true, ssr: typeof window === 'undefined', nonce }), [nonce]);
  return React.createElement(AppRouterContext.Provider, { value },
    React.createElement(NextAppRouterContext.Provider,{value:value.router},React.createElement(ScriptContext.Provider, { value: scripts }, children)));
}

module.exports.AppRouterContext = AppRouterContext;
module.exports.AppRouterProvider = AppRouterProvider;
module.exports.ReadonlyURLSearchParams = ReadonlyURLSearchParams;
