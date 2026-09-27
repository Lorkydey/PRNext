import { localePath } from '../compat/locale.cjs';
import React from 'react';
import DefaultApp, { loadGetInitialProps } from '../compat/app.cjs';
import { RouterProvider, makeRouter } from '../compat/router.cjs';
import { HeadProvider } from '../compat/head.cjs';
import { addBasePath, removeBasePath, normalizeTrailingSlash } from '../compat/paths.cjs';
import { withCacheRequest } from './cache-request.mjs';
import { installFetchCache } from './fetch-cache.mjs';
import { staticPath, validateStaticPaths, localizedStaticPaths } from './pages-paths.mjs';
import { loadModule } from './module-loader.mjs';
import { renderPageError, summarizePageFailure, restorePageFailure } from './pages-errors.mjs';
export { renderPageError } from './pages-errors.mjs';
import { CapturedResponse, createRequest, queryFromUrl, MAX_RESPONSE_BYTES, plainResponse } from './http.mjs';
import { currentRequest } from '../compat/headers.cjs';

// Preserve the original build/test API while request workers import the small
// HTTP and API modules directly and load this renderer only for Pages HTML.
export { loadModule } from './module-loader.mjs';
export { CapturedResponse, createRequest, queryFromUrl, escapeHtml, serializeData, MAX_RESPONSE_BYTES, errorResponse } from './http.mjs';
export { runApi } from './api.mjs';

installFetchCache();

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

function assertSerializable(value, path = 'props', parents = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || parents.has(value)) throw new Error(`${path} is not JSON serializable`);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${path} must contain only plain JSON values`);
  parents.add(value);
  for (const [key, child] of Object.entries(value)) assertSerializable(child, `${path}.${key}`, parents);
  parents.delete(value);
}

function revalidateValue(value) {
  if (value === undefined || value === false) return false;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('getStaticProps revalidate must be false or a nonnegative integer number of seconds');
  return value;
}

function dataResult(result, response, isStatic) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Data functions must return { props }, { notFound: true }, or { redirect }');
  if (isStatic) revalidateValue(result.revalidate);
  else if (result.revalidate !== undefined && result.revalidate !== false) throw new Error('getServerSideProps cannot specify revalidate');
  if (result.notFound !== undefined && typeof result.notFound !== 'boolean') throw new Error('notFound must be a boolean');
  const choices = Number(Object.hasOwn(result, 'props')) + Number(result.notFound === true) + Number(Object.hasOwn(result, 'redirect'));
  if (choices !== 1) throw new Error('Data functions must return exactly one of props, notFound, or redirect');
  if (result.notFound === true) return plainResponse(404, 'Not Found');
  if (Object.hasOwn(result, 'redirect')) {
    if (!result.redirect || typeof result.redirect !== 'object' || Array.isArray(result.redirect)) throw new Error('redirect must be an object');
    const { destination, permanent, statusCode } = result.redirect;
    if (typeof destination !== 'string' || /[\r\n]/.test(destination)) throw new Error('Invalid redirect destination');
    if ((permanent === undefined) === (statusCode === undefined) || (permanent !== undefined && typeof permanent !== 'boolean')) {
      throw new Error('redirect must specify either a boolean permanent or a valid statusCode');
    }
    if (result.redirect.basePath !== undefined && result.redirect.basePath !== false) throw new Error('redirect.basePath must be false when provided');
    const status = statusCode ?? (permanent ? 308 : 307);
    if (![301, 302, 303, 307, 308].includes(status)) throw new Error('Invalid redirect status');
    return { status, headers: { ...response.getHeaders(), location: destination }, body: Buffer.alloc(0) };
  }
  return null;
}

function canonicalPageUrl(value = '/') {
  const canonical = new URL('http://prnext.local');
  canonical.pathname = new URL(value, canonical).pathname;
  return canonical.href;
}

function visiblePageUrl(value, dataRequest, basePath) {
  const visible = new URL(value);
  visible.pathname = removeBasePath(visible.pathname, basePath);
  if (dataRequest && /^\/(?:_prnext|_next)\/data\//.test(visible.pathname)) {
    const parts = visible.pathname.split('/').slice(4);
    if (parts.at(-1)?.endsWith('.json')) {
      parts[parts.length - 1] = parts.at(-1).slice(0, -5);
      if (parts[0] === 'index') parts.shift();
      visible.pathname = `/${parts.join('/')}`;
    }
  }
  return visible;
}

export function renderPageData(options) {
  return renderPage({ ...options, renderMode: 'data' });
}

export async function renderPageRequest(options) {
  if (options.route?.errorStatus === 500 || options.renderMode === 'error500') return renderPageError({ ...options, nativeErrors: false }, { statusCode: 500, error: restorePageFailure(options.pageFailure) });
  if (options.renderMode === 'error404') return renderPageError({ ...options, nativeErrors: false }, { statusCode: 404 });
  const capturedResponse = new CapturedResponse();
  let result;
  try { result = await renderPage({ ...options, capturedResponse }); }
  catch (error) {
    if ([400, 504].includes(error?.statusCode) || options.signal?.aborted) throw error;
    console.error('[prnext]', error?.stack || error);
    return renderPageError(options, { statusCode: 500, error, responseHeaders: capturedResponse.getHeaders() });
  }
  if (result.pageError && options.renderMode !== 'data') {
    await result.finalizeCache?.();
    return renderPageError(options, { statusCode: result.pageError, responseHeaders: { ...result.headers, ...capturedResponse.getHeaders() } });
  }
  return result;
}

export function renderPage(options) {
  const input = options.renderMode === 'isr' || options.isFallback ? {
    ...options, url: canonicalPageUrl(options.url), originalUrl: undefined,
    method: 'GET', headers: {}, body: '',
  } : options;
  return withCacheRequest(input, 'pages', () => renderPageInner(input));
}

async function renderPageInner({ modulePath, route = {}, url = 'http://localhost/', originalUrl, params = {}, method = 'GET', headers = {}, body = '', staticProps, production = process.env.NODE_ENV === 'production', renderMode, isFallback = false, revalidateReason = 'stale', buildId, manifest, basePath = manifest?.config?.basePath || '', errorPage = false, errorStatus = route.errorStatus, error, errorDataRequest = false, capturedResponse, responseHeaders = {}, documentRequest, middlewareMatched = false }) {
  const mod = await loadModule(modulePath);
  const Page = mod.default;
  if (typeof Page !== 'function' && typeof Page !== 'object') throw new Error('Page must export a React component as default');
  const App = mod.App || DefaultApp;
  const hasPageInitialProps = typeof Page.getInitialProps === 'function';
  const hasAppInitialProps = App.getInitialProps !== App.origGetInitialProps;
  if (hasPageInitialProps && (mod.getStaticProps || mod.getServerSideProps)) throw new Error('getInitialProps cannot be combined with getStaticProps or getServerSideProps on the same page');
  if (mod.getServerSideProps && mod.getStaticProps) throw new Error('A page cannot define both getServerSideProps and getStaticProps');
  const isStatic = typeof mod.getStaticProps === 'function';
  if (renderMode === 'isr' && !isStatic) throw new Error('ISR rendering requires a getStaticProps page');
  if (isFallback && !isStatic) throw new Error('Fallback rendering requires a getStaticProps page');
  if (!['build', 'stale', 'on-demand'].includes(revalidateReason)) throw new TypeError('Invalid getStaticProps revalidateReason');
  let devNotFound = false;
  if (renderMode === 'isr' && manifest?.dev && route.pattern?.includes('[')) {
    if (typeof mod.getStaticPaths !== 'function') throw new Error(`Dynamic page ${route.pattern} with getStaticProps must export getStaticPaths.`);
    const listing = localizedStaticPaths(route, await mod.getStaticPaths(manifest.config?.i18n ? {locales:manifest.config.i18n.locales,defaultLocale:manifest.config.i18n.defaultLocale} : {}), manifest.config?.i18n);
    const requested = staticPath(route.pattern, new URL(url).pathname).path;
    devNotFound = listing.fallback === false && !listing.paths.some(entry => entry.path === requested);
  }
  const requestOriginal = originalUrl ? new URL(originalUrl, url) : undefined;
  if (requestOriginal) requestOriginal.pathname = removeBasePath(requestOriginal.pathname, basePath);
  const { request, url: parsed } = createRequest({ url, originalUrl: requestOriginal?.href, method, headers, body, params });
  const previewData = currentRequest().previewData;
  const preview = previewData !== false;
  request.draftMode = currentRequest().draftMode;
  request.preview = preview;
  request.previewData = previewData;
  const dataRequest = renderMode === 'data';
  const visible = visiblePageUrl(originalUrl ? new URL(originalUrl, parsed) : parsed, dataRequest || errorDataRequest || errorPage, originalUrl ? basePath : '');
  const response = capturedResponse || new CapturedResponse();
  for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value);
  if (errorStatus) response.statusCode = errorStatus;
  let result = devNotFound ? { notFound: true, revalidate: 0 } : isFallback ? { props: {} } : staticProps;
  const errorQuery = queryFromUrl(visible);
  const i18n = manifest?.config?.i18n;
  const locale = route.locale || (i18n ? localePath(visible.pathname, i18n).locale : undefined);
  const domainLocale = i18n?.domains?.find(value => value.domain.toLowerCase() === new URL(url).host.toLowerCase());
  const language = i18n ? {locale,locales:i18n.locales,defaultLocale:domainLocale?.defaultLocale || i18n.defaultLocale} : {};
  const snapshot = { ...language, ...(i18n ? {i18n,domain:new URL(url).host,domainLocales:i18n.domains,isLocaleDomain:!!domainLocale} : {}), pathname: route.internal && errorStatus ? '/_error' : route.originalPattern || route.pattern || parsed.pathname, query: errorPage && route.pattern === '/_error' ? errorQuery : isStatic || isFallback ? { ...params } : request.query,
    asPath: isStatic || isFallback ? normalizeTrailingSlash(parsed.pathname, manifest?.config) : `${errorPage && route.errorStatus ? route.pattern : visible.pathname}${visible.search}`, isFallback, isReady: true, basePath, trailingSlash: manifest?.config?.trailingSlash || false, skipTrailingSlashRedirect: manifest?.config?.skipTrailingSlashRedirect || false, isPreview: preview,
    ...(originalUrl && !isStatic && !isFallback && visible.href !== parsed.href ? { rewrite: { url: `${parsed.pathname}${parsed.search}`, params } } : {}) };
  let documentRequestObject = request;
  if (route.internal && route.errorStatus && !errorPage) {
    documentRequestObject = createRequest({ url: new URL(`/${errorStatus}`, url).href, method, headers }).request;
  } else if (renderMode === 'isr' && documentRequest) {
    const documentUrl = new URL(documentRequest.url.startsWith('/') ? new URL(url).origin + documentRequest.url : documentRequest.url, url);
    const original = documentRequest.originalUrl ? new URL(documentRequest.originalUrl, documentUrl) : undefined;
    if (original) original.pathname = removeBasePath(original.pathname, basePath);
    documentRequestObject = createRequest({ url: documentUrl.href, originalUrl: original?.href,
      method: documentRequest.method, headers: documentRequest.headers, params }).request;
  }
  const autoStatic = !route.errorStatus && !errorPage && !hasPageInitialProps && !hasAppInitialProps && !isStatic && !mod.getServerSideProps;
  if (i18n) snapshot.asPath = localePath(snapshot.asPath, i18n).pathname;
  const router = makeRouter(snapshot);
  const AppTree = ({ pageProps = {}, ...props }) => React.createElement(RouterProvider, { router: snapshot },
    React.createElement(HeadProvider, { collector: [] }, React.createElement(App, { ...props, Component: Page, pageProps, router })));
  const context = { err: error, req: autoStatic ? undefined : documentRequestObject, res: autoStatic ? undefined : response,
    ...language, pathname: snapshot.pathname, query: autoStatic ? {} : snapshot.query,
    asPath: autoStatic ? snapshot.pathname : snapshot.asPath, AppTree };
  // Browser transitions resolve rewrites here, then run legacy hooks in the
  // browser. SSG/SSP still fetch their complete, server-produced App props.
  const navigationRequest = dataRequest && request.headers['x-prnext-navigation'] === '1' && !isStatic && !mod.getServerSideProps;
  const routingOnly = navigationRequest && !middlewareMatched;
  const legacyNavigation = navigationRequest && middlewareMatched && (hasPageInitialProps || hasAppInitialProps);
  const navigationResponse = result => {
    if (!legacyNavigation) return result;
    const headers = { ...result.headers, 'x-prnext-legacy-navigation': '1' };
    const location = Array.isArray(headers.location) ? headers.location[0] : headers.location;
    if ([301, 302, 303, 307, 308].includes(result.status) && typeof location === 'string') {
      // Fetch must follow this legacy hook response, then continue the original
      // page's client hooks. Keep it distinct from a router redirect, which
      // changes the selected page and history URL.
      delete headers.location;
      headers['x-prnext-legacy-location'] = location;
      return { ...result, status: 200, headers, body: Buffer.alloc(0) };
    }
    return { ...result, headers };
  };
  const initial = routingOnly ? { pageProps: {} } : await loadGetInitialProps(App, { AppTree, Component: Page, router, ctx: context });
  if (response.writableEnded) return navigationResponse(response.result());
  const { pageProps: initialPageProps = {}, ...appProps } = initial;
  if (result === undefined && mod.getServerSideProps) {
    result = await mod.getServerSideProps({ req: request, res: response, params, query: request.query,
      ...language, resolvedUrl: `${localePath(parsed.pathname, i18n).pathname}${visible.search}`, preview, previewData, draftMode: currentRequest().draftMode });
    if (result === undefined && !response.writableEnded) throw new Error('getServerSideProps must return a result');
  } else if (result === undefined && mod.getStaticProps) {
    result = await mod.getStaticProps({ ...language, params, preview, previewData, draftMode: currentRequest().draftMode, revalidateReason });
    if (result === undefined) throw new Error('getStaticProps must return a result');
  }
  if (response.writableEnded) return response.result();
  result ??= { props: initialPageProps };
  if (errorStatus && (result.notFound || result.redirect)) throw new Error(`The ${errorStatus} page cannot return notFound or redirect`);
  const early = dataResult(result, response, isStatic);
  const revalidate = isStatic ? revalidateValue(result.revalidate) : false;
  const pageData = props => ({ ...appProps, pageProps: props, ...(isStatic ? { __N_SSG: true } : mod.getServerSideProps ? { __N_SSP: true } : {}), __PRNEXT_ROUTER__: snapshot });
  const dataResponse = (data, status = response.statusCode, redirect = false) => {
    const dataJSON = JSON.stringify(data);
    if (Buffer.byteLength(dataJSON) > MAX_RESPONSE_BYTES) throw new Error('Page data exceeds the 16 MiB PRNext limit');
    const responseHeaders = { 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
      'content-type': 'application/json; charset=utf-8', ...response.result().headers };
    if (redirect) responseHeaders['content-type'] = 'application/json; charset=utf-8';
    return { status, headers: responseHeaders, body: [204, 205, 304].includes(status) ? Buffer.alloc(0) : Buffer.from(dataJSON) };
  };
  const withData = (rendered, data) => {
    if (!isStatic && !isFallback) return rendered;
    const dataJSON = JSON.stringify(data);
    if (Buffer.byteLength(dataJSON) > MAX_RESPONSE_BYTES) throw new Error('Page data exceeds the 16 MiB PRNext limit');
    return { ...rendered, dataJSON, revalidate, generatedAt: Date.now() };
  };
  if (early) {
    const data = result.notFound ? { notFound: true } : pageData({
      __N_REDIRECT: result.redirect.destination,
      __N_REDIRECT_STATUS: early.status,
      ...(result.redirect.basePath === undefined ? {} : { __N_REDIRECT_BASE_PATH: result.redirect.basePath }),
    });
    if (dataRequest) return dataResponse(data, result.notFound ? 404 : response.statusCode, !!result.redirect);
    if (result.redirect) {
      if (result.redirect.basePath !== false) early.headers.location = addBasePath(early.headers.location, basePath);
      if (early.headers.location.startsWith('/')) {
        const [pathname, ...query] = early.headers.location.split('?');
        early.headers.location = pathname.replace(/\\/g, '/').replace(/\/{2,}/g, '/') + (query[0] ? `?${query.join('?')}` : '');
      }
    }
    return withData({ ...early, ...(result.notFound ? { pageError: 404 } : {}) }, data);
  }
  const dataProps = await result.props;
  if (isStatic || mod.getServerSideProps) {
    if (dataProps === null || typeof dataProps !== 'object' || Array.isArray(dataProps)) throw new Error('props must be a plain object');
    assertSerializable(dataProps);
  }
  const props = isFallback ? {} : isStatic || mod.getServerSideProps ? { ...initialPageProps, ...dataProps } : dataProps;
  // Client transitions execute data functions only. In particular, neither
  // React rendering nor dynamic() SSR preloading belongs to a data request.
  const legacyDataHtml = dataRequest && !isStatic && !mod.getServerSideProps && (hasPageInitialProps || hasAppInitialProps);
  if (dataRequest && (!legacyDataHtml || routingOnly)) return dataResponse(pageData(props), errorStatus === 404 ? 200 : response.statusCode);
  const { renderDocument } = await import('./document.mjs');
  const document = await renderDocument({ Document: mod.Document, App, Page, props, appProps, snapshot, route, request: documentRequestObject,
    response, error, production, buildId: buildId ?? manifest?.buildId, manifest, isStatic,
    hasServerProps: typeof mod.getServerSideProps === 'function', hasPageInitialProps, hasAppInitialProps });
  if (document.ended) return navigationResponse(response.result());
  // A middleware data probe performs the observable server render before the
  // browser executes its own hooks. Only routing metadata is needed on wire.
  if (navigationRequest) return navigationResponse(dataResponse({ pageProps: {}, __PRNEXT_ROUTER__: snapshot }));
  const html = document.html;
  return withData({ status: response.statusCode, headers: { ...HTML_HEADERS, ...response.result().headers }, body: Buffer.from(html) }, pageData(props));
}

export async function renderIsrPage(options) {
  let response;
  try { response = await renderPage({ ...options, renderMode: 'isr' }); }
  catch (error) {
    if (!options.capturePageFailure) throw error;
    const pageFailure = summarizePageFailure(error);
    console.error('[prnext] Page generation failed:', pageFailure.stack || pageFailure.message);
    return { status: 500, headers: {}, body: Buffer.alloc(0), pageFailure };
  }
  const html = response.body;
  const data = Buffer.from(response.dataJSON);
  return { status: response.status, headers: response.headers, finalizeCache: response.finalizeCache,
    body: [html, data], isr: { revalidate: response.revalidate, htmlLength: html.byteLength, dataLength: data.byteLength } };
}

export async function renderFallback(options) {
  const { path = options.route?.pattern || options.pattern || '/', pattern, client, css, ...input } = options;
  const response = await renderPage({ ...input, url: canonicalPageUrl(path),
    route: options.route || { pattern, client, css }, params: {}, isFallback: true });
  await response.finalizeCache?.();
  return { ...response, body: response.body.toString('utf8') };
}

export async function prerenderRoute({ modulePath, path = '/', params = {}, client, css = [], pattern, production = true, buildId, revalidateReason = 'build', basePath = '', manifest, distDir, route, errorStatus = route?.errorStatus }) {
  const mod = await loadModule(modulePath);
  if (mod.getServerSideProps) throw new Error('getServerSideProps pages cannot be prerendered');
  const options = { modulePath, url: canonicalPageUrl(path), params,
    route: route || { pattern, client, css }, buildId, revalidateReason, production, basePath, manifest, distDir, errorStatus };
  let result = await renderPage(options);
  await result.finalizeCache?.();
  if (result.pageError && manifest) {
    const replacement = await renderPageError(options, { statusCode: result.pageError });
    await replacement.finalizeCache?.();
    result = { ...result, body: replacement.body, headers: replacement.headers };
  }
  return { ...result, body: result.body.toString('utf8') };
}

export async function getStaticPaths({ modulePath }) {
  const mod = await loadModule(modulePath);
  return mod.getStaticPaths ? mod.getStaticPaths({}) : null;
}
