import { runRequestContext, currentRequest } from '../compat/headers.cjs';
import { flushCacheInvalidations, flushCacheWork } from '../compat/data-cache.cjs';

// Keep background fills alive until the transport has sent the response. In
// particular, serving stale data must not wait for its replacement to finish.
export function withCacheRequest(options, phase, callback) {
  // Raw upload bytes belong to the IncomingMessage/Request. Async cache work
  // only needs metadata, and may survive the response for stale revalidation.
  return runRequestContext({ ...options, body: undefined, routePattern: options.route?.pattern, cacheConfig: options.route?.cacheConfig, phase }, async () => {
    const context = currentRequest();
    try {
      const response = await callback(context);
      await flushCacheInvalidations(context);
      context.cacheState.closed = true;
      return { ...response,
        ...(context.draftMode || context.draftChanged ? { headers: { ...response.headers, 'cache-control': 'private, no-cache, no-store, max-age=0' } } : {}),
        finalizeCache: () => flushCacheWork(context) };
    } catch (error) {
      await flushCacheWork(context);
      throw error;
    }
  });
}
