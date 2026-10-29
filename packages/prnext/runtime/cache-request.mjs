import {reportRequestError} from './instrumentation.mjs';
import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { flushCacheInvalidations, flushCacheWork } from '../compat/data-cache.cjs';
import { createAfterScope } from '../compat/after.cjs';

// Keep background fills alive until the transport has sent the response. In
// particular, serving stale data must not wait for its replacement to finish.
export function withCacheRequest(options, phase, callback) {
  // Raw upload bytes belong to the IncomingMessage/Request. Async cache work
  // only needs metadata, and may survive the response for stale revalidation.
  return runRequestContext({ ...options, body: undefined, routePattern: options.route?.pattern, cacheConfig: options.route?.cacheConfig, phase }, async () => {
    const context = currentRequest();
    if (phase === 'route' && options.route?.cacheConfig?.runtime !== 'edge') context.afterScope = createAfterScope({report:error=>{console.error('[prnext] after() failed:',error?.stack||error);return reportRequestError(error);}, signal: options.signal, timeoutMs: options.timeoutMs ?? (options.route?.cacheConfig?.maxDuration ? options.route.cacheConfig.maxDuration * 1000 : 25000) });
    let finalized;
    const finalizeCache = () => finalized ||= (async () => { await context.afterScope?.finish(); await flushCacheWork(context); })();
    // The worker owns response completion even when application code throws.
    // Register before invoking it so error responses do not await after().
    options.deferFinalizer?.(finalizeCache);
    try {
      const response = await callback(context);
      await flushCacheInvalidations(context);
      context.cacheState.closed = true;
      return { ...response,
        ...(context.draftMode || context.draftChanged ? { headers: { ...response.headers, 'cache-control': 'private, no-cache, no-store, max-age=0' } } : {}),
        finalizeCache };
    } catch (error) {
      context.cacheState.closed = true;
      if (!options.deferFinalizer) await finalizeCache();
      throw error;
    }
  });
}
