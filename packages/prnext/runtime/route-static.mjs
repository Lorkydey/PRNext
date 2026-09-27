import { loadModule } from './module-loader.mjs';
import { runApi } from './api.mjs';
import { MAX_RESPONSE_BYTES } from './http.mjs';
import { collectStaticParams, validateRuntimeStaticConfig } from './app-static-params.mjs';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { flushCacheWork, getCachePaths } from '../compat/data-cache.cjs';
import { trackStaticDependency, staticMetadata } from '../compat/static-generation.cjs';
import { apiTimeoutError, withSignal } from './stream-utils.mjs';

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
const NON_STATIC = ['OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

function descriptor(module, route) {
  const entry = { page: module, pageConfig: route.handlerConfig, segments: [] };
  validateRuntimeStaticConfig(entry);
  const methods = METHODS.filter(method => typeof module[method] === 'function');
  const optedIn = module.dynamic === 'force-static' || module.dynamic === 'error' ||
    module.revalidate === false || module.revalidate > 0 || typeof module.generateStaticParams === 'function';
  return { entry, methods, hasExplicitHead: methods.includes('HEAD'),
    staticEligible: module.runtime !== 'edge' && methods.includes('GET') && optedIn && module.dynamic !== 'force-dynamic' && !NON_STATIC.some(method => methods.includes(method)) };
}

function canonicalOptions(options) {
  const url = new URL('http://prnext.local');
  url.pathname = new URL(options.path || options.url || '/', url).pathname;
  return { ...options, url: url.href, originalUrl: undefined, params: options.params || {},
    method: options.renderMode === 'isr' && options.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: {}, body: '', production: options.production ?? true };
}

function deadline(options, phase) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 25_000;
  // Keep the timer alive while awaiting an otherwise handle-free import or
  // generator so Node reports the timeout rather than exiting on pending TLA.
  const timer = setTimeout(() => controller.abort(apiTimeoutError(phase, timeoutMs)), timeoutMs);
  return { signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    close: () => clearTimeout(timer) };
}

export async function inspectAppRouteHandler(options) {
  const request = canonicalOptions(options);
  const work = deadline(options, 'Route Handler static parameters');
  try {
    return await runRequestContext({ ...request, signal: work.signal, phase: 'route', cacheConfig: options.route?.cacheConfig }, async () => {
      const context = currentRequest();
      try {
        work.signal.throwIfAborted();
        const { entry, ...info } = descriptor(await withSignal(loadModule(options.modulePath), work.signal), options.route || {});
        return { ...info, ...await withSignal(collectStaticParams(entry, options.route?.pattern), work.signal) };
      } finally { await flushCacheWork(context); }
    });
  } finally { work.close(); }
}

export async function prerenderAppRouteHandler(options) {
  const request = canonicalOptions(options);
  const config = options.route?.cacheConfig || {};
  const mode = config.dynamic || 'auto';
  const work = deadline(options, 'static Route Handler');
  request.signal = work.signal;
  try {
    work.signal.throwIfAborted();
    const { staticEligible } = descriptor(await withSignal(loadModule(options.modulePath), work.signal), options.route || {});
    if (!staticEligible) return { dynamic: true, reason: 'Route Handler has no static GET opt-in or exports non-static methods' };
    if (config.revalidate === 0 && mode !== 'force-static') return { dynamic: true, reason: 'revalidate: 0' };
    return await runRequestContext({ ...request, phase: 'route', cacheConfig: config,
      routePattern: options.route?.pattern, staticGeneration: { mode } }, async () => {
      const context = currentRequest();
      let response;
      try {
        trackStaticDependency({ paths: getCachePaths(context) }, context);
        response = await runApi({ ...request, stream: true, preserveHeadBody: true,
          staticState: context.staticState, cacheState: context.cacheState });
        staticMetadata(context);
        // Build exports keep successful responses, redirects and not-found. A
        // request-time regeneration preserves the handler's actual status.
        if (options.renderMode !== 'isr' && response.status >= 400 && response.status !== 404) {
          return { dynamic: true, reason: `Route Handler returned status ${response.status}` };
        }
        const chunks = [];
        let length = 0;
        const body = response.body;
        const source = Buffer.isBuffer(body) || typeof body === 'string' ? [body] : body;
        for await (const chunk of source || []) {
          const bytes = Buffer.from(chunk);
          length += bytes.byteLength;
          if (length > MAX_RESPONSE_BYTES) throw new Error('Static Route Handler response exceeds the 16 MiB PRNext limit');
          chunks.push(bytes);
        }
        await response.finalizeCache?.();
        const metadata = staticMetadata(context);
        if (metadata.externalCache) return { dynamic: true, reason: 'External cache handlers must be consulted at request time' };
        if (Buffer.byteLength(JSON.stringify({ ...metadata, headers: response.headers })) > 60 * 1024) {
          throw new Error('Static Route Handler response headers and dependencies exceed the PRNext metadata limit');
        }
        return { body: Buffer.concat(chunks, length), status: response.status, headers: response.headers,
          ...metadata, generatedAt: Date.now() };
      } finally {
        await response?.cancel?.();
        await flushCacheWork(context);
      }
    });
  } catch (error) {
    if (error.code === 'PRNEXT_DYNAMIC_SERVER_USAGE' && mode !== 'error') return { dynamic: true, reason: error.dynamicReason || error.message };
    throw error;
  } finally { work.close(); }
}

export async function renderRouteHandlerIsr(options) {
  const rendered = await prerenderAppRouteHandler({ ...options, renderMode: 'isr' });
  if (rendered.dynamic) return { status: 200, headers: {}, body: [],
    isr: { kind: 'route', dynamic: true, revalidate: 0, htmlLength: 0, dataLength: 0, tags: [], paths: [] } };
  return { status: rendered.status, headers: rendered.headers, body: [rendered.body],
    isr: { kind: 'route', revalidate: rendered.revalidate, htmlLength: rendered.body.byteLength,
      dataLength: 0, tags: rendered.tags, paths: rendered.paths } };
}
