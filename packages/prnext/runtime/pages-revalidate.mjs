import { nativeFetch, optionalRequestContext } from '../compat/data-cache.cjs';
import { removeBasePath } from '../compat/paths.cjs';

export async function revalidatePage(response, pathname, options = {}) {
  if (!response._canRevalidate) throw new Error('res.revalidate() is only available in Pages API routes');
  if (response.headersSent || response.writableEnded) throw new Error('res.revalidate() must be called before sending response headers');
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(pathname)) {
    throw new TypeError('res.revalidate() requires an absolute application path, such as /posts/1');
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (options.unstable_onlyGenerated !== undefined && typeof options.unstable_onlyGenerated !== 'boolean')) {
    throw new TypeError('res.revalidate() options.unstable_onlyGenerated must be a boolean');
  }
  const url = process.env.PRNEXT_CACHE_URL;
  const token = process.env.PRNEXT_CACHE_TOKEN;
  if (!url || !token) throw new Error('res.revalidate() requires a running PRNext server');
  const context = optionalRequestContext();
  const path = removeBasePath(new URL(pathname, 'http://prnext.local').pathname, context?.basePath || '');
  const signal = response._revalidateSignal || context?.signal;
  const timeout = AbortSignal.timeout(25_000);
  const result = await nativeFetch(new URL('/pages/revalidate', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ path, ...(options.unstable_onlyGenerated === undefined ? {} : { onlyGenerated: options.unstable_onlyGenerated }) }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!result.ok) {
    await result.body?.cancel();
    throw new Error(`Failed to revalidate ${path} (${result.status})`);
  }
  const value = await result.json();
  if (typeof value?.revalidated !== 'boolean') throw new Error('Invalid PRNext page revalidation response');
}
