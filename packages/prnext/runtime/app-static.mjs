import path from 'node:path';
import { addBasePath, removeBasePath } from '../compat/paths.cjs';
import { renderFlight, decodeFlight, renderHtml, completeAppHtml } from './app-render.mjs';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { flushCacheWork } from '../compat/data-cache.cjs';
import { trackStaticDependency, staticMetadata } from '../compat/static-generation.cjs';
import { prerenderPartialHtml } from './app-partial.mjs';
import { partialKeyMap } from './app-partial-model.mjs';

export function requestOptions(options) {
  const route = options.route || {};
  const canonical = new URL('http://prnext.local');
  canonical.pathname = new URL(options.path || options.url || '/', canonical).pathname;
  return { modulePath: options.modulePath, distDir: options.distDir || path.dirname(path.dirname(options.modulePath)),
    routePattern: route.pattern, cacheConfig: route.cacheConfig || {}, css: route.css || [], fonts: route.fonts || [], production: options.production ?? true,
    url: canonical.href, originalUrl: options.originalUrl ? new URL(new URL(options.originalUrl).pathname, canonical).href : undefined,
    partialParams: options.partialParams, basePath: options.manifest?.config?.basePath || '', trailingSlash: options.manifest?.config?.trailingSlash || false, skipTrailingSlashRedirect: options.manifest?.config?.skipTrailingSlashRedirect || false, params: options.params || {}, method: 'GET', headers: {},
    ...(options.seed ? { partialFlight: options.seed.flight, partialKeys: [...partialKeyMap(options.seed.keyScopes, options.params, removeBasePath(canonical.pathname, options.manifest?.config?.basePath || ''))] } : {}),
    clientModules: options.manifest?.app?.clientModules || {},
    cacheComponents: options.manifest?.config?.cacheComponents, cacheLife: options.manifest?.config?.cacheLife, cacheHandlers: options.manifest?.config?.cacheHandlers, cacheHandler: options.manifest?.config?.cacheHandler, cacheMaxMemorySize: options.manifest?.config?.cacheMaxMemorySize,
    actions: options.manifest?.app?.actions || {}, actionKey: options.manifest?.app?.actionKey };
}

export function inspectAppStatic(options) {
  return renderFlight({ ...requestOptions(options), operation: 'static-params' });
}

export async function prerenderAppRoute(options) {
  const request = requestOptions(options);
  const mode = request.cacheConfig.dynamic || 'auto';
  if (request.cacheConfig.runtime === 'edge' || mode === 'force-dynamic' || (request.cacheConfig.revalidate === 0 && mode !== 'force-static')) {
    return { dynamic: true, reason: request.cacheConfig.runtime === 'edge' ? 'runtime: edge' : mode === 'force-dynamic' ? 'dynamic: force-dynamic' : 'revalidate: 0' };
  }
  try {
    const partial = request.cacheComponents === true && mode === 'auto';
    const result = await renderFlight({ ...request, staticGeneration: { mode, partial } });
    return await runRequestContext({ ...request, phase: 'render', staticGeneration: { mode } }, async () => {
      const context = currentRequest();
      try {
        trackStaticDependency(result.staticMetadata, context);
        if (result.status >= 500) throw new Error('Static App rendering failed');
        let html;
        if (result.navigation) html = result.navigation.body;
        else {
          const model = await decodeFlight(result.body, request.clientModules, request.distDir, { production: request.production });
          if (partial) {
            const shell = await prerenderPartialHtml(model, options.route, { strictMode: options.manifest?.config?.reactStrictMode !== false, unknownParams: request.partialParams?.length > 0 });
            if (!shell) {
              if (request.cacheConfig.instant === false) return { dynamic: true, reason: 'instant: false permits blocking request data outside Suspense' };
              throw Object.assign(new Error(`Route ${request.routePattern}: uncached data was accessed outside of <Suspense>. Move request APIs, uncached fetches or unknown params into a component beneath <Suspense>, cache the data with "use cache", or explicitly permit blocking with export const instant = false.`), { code: 'PRNEXT_MISSING_SUSPENSE' });
            }
            if (result.staticMetadata?.metadataDynamic && !result.staticMetadata?.contentDynamic && !shell.clientDynamic) {
              throw Object.assign(new Error(`Route ${request.routePattern}: generateMetadata() accesses uncached or request data while the page content is static. Cache the metadata with "use cache" or render a component that awaits connection() beneath <Suspense>.`), { code: 'PRNEXT_DYNAMIC_METADATA' });
            }
            if (shell.postponed) return { partial: { version: 1, ...shell, flight: result.body.toString('base64'),
              ...(request.partialParams?.length ? { generic: { params: request.params, unknown: request.partialParams, path: new URL(request.url).pathname }, keyScopes: model.keyScopes || [] } : {}) },
              metadata: { ...staticMetadata(context), generatedAt: Date.now() } };
            if (result.staticMetadata?.dynamicReasons?.length) {
              if (request.cacheConfig.instant === false) return { dynamic: true, reason: 'instant: false permits blocking request data outside Suspense' };
              throw Object.assign(new Error(`Route ${request.routePattern}: request data was intercepted outside of a resumable <Suspense> boundary.`), { code: 'PRNEXT_MISSING_SUSPENSE' });
            }
            html = completeAppHtml(shell.shell, result.body, { ...options.route, css: [], fonts: [] });
          } else {
            html = completeAppHtml(await renderHtml(model.tree, model.router, { staticGeneration: true, strictMode: options.manifest?.config?.reactStrictMode !== false }), result.body, options.route);
          }
        }
        if (staticMetadata(context)?.externalCache) return { dynamic: true, reason: 'External cache handlers require validation on every request' };
        return { body: html, flight: result.body, ...staticMetadata(context), generatedAt: Date.now(),
          status: result.status, headers: { ...result.headers, ...(result.headers?.location ? { location: addBasePath(result.headers.location, request.basePath) } : {}), 'content-type': 'text/html; charset=utf-8' } };
      } finally { await flushCacheWork(context); }
    });
  } catch (error) {
    if (error.code === 'PRNEXT_DYNAMIC_SERVER_USAGE' && mode === 'auto') return { dynamic: true, reason: error.dynamicReason || error.message };
    throw error;
  }
}

export async function renderAppIsrPage(options) {
  const rendered = await prerenderAppRoute(options);
  if (rendered.dynamic) return { status: 200, headers: {}, body: [],
    isr: { dynamic: true, revalidate: 0, htmlLength: 0, dataLength: 0, tags: [], paths: [] } };
  const html = Buffer.from(rendered.body);
  return { status: rendered.status, headers: rendered.headers, body: [html, rendered.flight],
    isr: { revalidate: rendered.revalidate, htmlLength: html.byteLength, dataLength: rendered.flight.byteLength,
      tags: rendered.tags, paths: rendered.paths } };
}
