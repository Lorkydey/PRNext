import path from 'node:path';
import {localePath} from '../compat/locale.cjs';
import {removeBasePath} from '../compat/paths.cjs';
import { readFile, stat } from 'node:fs/promises';
import { MAX_RESPONSE_BYTES } from './http.mjs';

function boundedText(value, bytes) {
  if (typeof value !== 'string') return undefined;
  const prefix = value.slice(0, bytes);
  const buffer = Buffer.from(prefix);
  if (buffer.length <= bytes) return buffer.toString('utf8');
  let end = bytes;
  while ((buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

// Private worker metadata only. Custom prototypes and arbitrary object graphs
// cannot cross processes; never attach this summary to an HTTP response.
export function summarizePageFailure(error) {
  const read = name => { try { return error?.[name]; } catch { return undefined; } };
  const statusCode = read('statusCode'), code = read('code'), stack = read('stack');
  return { name: boundedText(read('name'), 128) ?? 'Error',
    message: boundedText(typeof error === 'string' ? error : read('message'), 2048) ?? 'Page generation failed',
    ...(typeof stack === 'string' ? { stack: boundedText(stack, 4096) } : {}),
    ...(Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}),
    ...(typeof code === 'string' ? { code: boundedText(code, 256) }
      : code === null || typeof code === 'boolean' || typeof code === 'number' && Number.isFinite(code) ? { code } : {}) };
}

export function restorePageFailure(summary) {
  if (!summary) return undefined;
  const value = summarizePageFailure(summary);
  return Object.assign(new Error(value.message), value);
}

export function builtinPageError(statusCode = 500, headers = {}) {
  const title = statusCode === 404 ? 'This page could not be found.' : 'Internal Server Error';
  return { status: statusCode, headers: { ...headers, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate' },
    body: Buffer.from(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${statusCode}: ${title}</title></head><body><main><h1>${statusCode}</h1><p>${title}</p></main></body></html>`) };
}

export function errorRoute(manifest = {}, statusCode, locale) {
  const id = statusCode === 404 ? manifest.appNotFound || manifest.pagesErrors?.notFound || manifest.pagesErrors?.error
    : manifest.pagesErrors?.serverError || manifest.pagesErrors?.error;
  return manifest.routes?.find(route => route.id === (locale && locale !== manifest.config?.i18n?.defaultLocale && id !== manifest.appNotFound ? `${id}-locale-${locale}` : id));
}

export async function renderPageError(options, { statusCode = 500, error, responseHeaders = {} } = {}) {
  const i18n = options.manifest?.config?.i18n;
  const locale = options.route?.locale || (i18n && localePath(removeBasePath(new URL(options.url || 'http://prnext.local').pathname, options.manifest.config.basePath || ''), i18n).locale);
  const route = errorRoute(options.manifest, statusCode, locale);
  if (!route) return builtinPageError(statusCode, responseHeaders);
  const seed = options.manifest?.prerendered?.find(page => page.path === route.pattern);
  // Native owns the live 404/500 cache, including revalidation after build.
  if (options.nativeErrors && (seed || route.router === 'app')) {
    return { status: statusCode, pageError: statusCode, headers: { ...responseHeaders, 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate' }, body: Buffer.alloc(0) };
  }
  try {
    const distDir = options.distDir || path.dirname(path.dirname(options.modulePath));
    if (seed && !options.manifest?.dev) {
      const file = path.resolve(distDir, seed.file);
      if (!file.startsWith(path.resolve(distDir) + path.sep) || (await stat(file)).size > MAX_RESPONSE_BYTES) throw new Error('Invalid prerendered error page');
      return { status: statusCode, headers: { ...seed.headers, ...responseHeaders, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate' }, body: await readFile(file) };
    }
    const modulePath = path.resolve(distDir, route.module);
    if (route.router === 'app') {
      const { renderAppPage } = await import('./app-render.mjs');
      const result = await renderAppPage({ ...options, modulePath, route, method: 'GET', body: '', stream: false });
      return { ...result, status: 404 };
    }
    const { renderPage } = await import('./render.mjs');
    responseHeaders = { ...responseHeaders };
    for (const name of ['content-type', 'content-length', 'content-encoding', 'etag', 'last-modified']) delete responseHeaders[name];
    const result = await renderPage({ ...options, route, modulePath, params: {}, staticProps: undefined,
      ...((route.originalPattern || route.pattern) !== '/_error' ? route.appGip && !route.ssg
        ? { url: `http://prnext.local${route.pattern}${new URL(options.originalUrl || options.url).search}`, originalUrl: options.originalUrl || options.url }
        : { url: `http://prnext.local${route.pattern}`, originalUrl: undefined } : {}),
      renderMode: 'error', errorDataRequest: options.renderMode === 'data', errorPage: true,
      errorStatus: statusCode, error, responseHeaders, method: 'GET', body: '', isFallback: false });
    return { ...result, headers: { ...result.headers, 'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate' } };
  } catch (failure) {
    console.error('[prnext] Error page failed:', failure?.stack || failure);
    return builtinPageError(500, responseHeaders);
  }
}
