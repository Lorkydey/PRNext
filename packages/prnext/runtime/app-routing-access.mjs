import path from 'node:path';
import { addBasePath, removeBasePath } from '../compat/paths.cjs';
import { readRouterState } from './app-routing-state.mjs';
import { nativeFetch } from '../compat/data-cache.cjs';

async function nativeResolution(resolver, url, headers, signal) {
  const response = await nativeFetch(resolver.url, { method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Bearer ${resolver.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: url.pathname + url.search, headers: Object.fromEntries(headers) }) });
  if (!response.ok) { await response.body?.cancel(); return null; }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 192 * 1024) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const result = JSON.parse(Buffer.concat(chunks, size));
  return result.status >= 200 && result.status < 300 && result.resolved ? result : null;
}

function matches(rule, url, headers) {
  if (!new RegExp(rule.regex, 'i').test(url.pathname)) return false;
  const cookies = new Map();
  for (const part of (headers.get('cookie') || '').split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    const key = part.slice(0, equals).trim();
    let value = part.slice(equals + 1).trim().replace(/^"|"$/g, '');
    try { value = decodeURIComponent(value); } catch { /* Keep malformed literal escapes. */ }
    if (!cookies.has(key)) cookies.set(key, value);
  }
  function condition(item) {
    const query = item.type === 'query' ? url.searchParams.getAll(item.key) : [];
    const value = item.type === 'host' ? (headers.get('host') || url.host).split(':')[0].toLowerCase()
      : item.type === 'query' ? query.at(-1) : item.type === 'cookie' ? cookies.get(item.key) : headers.get(item.key);
    return value !== null && value !== undefined && (value !== '' || query.length > 1) && (!item.regex || new RegExp(item.regex).test(value));
  }
  return (rule.has || []).every(condition) && !(rule.missing || []).some(condition);
}

/** Recheck saved route access under current credentials before any restored module runs. */
export async function authorizeAdvancedRouting(request, signal) {
  const middleware = request.routingMiddleware;
  const state = readRouterState(request);
  if (!state) return true;
  // Builds and programmatic rendering have no native bridge. Keep the bounded
  // middleware fallback for those callers; production workers use the full
  // native pipeline, including configuration-only redirects and rewrites.
  if (!request.routingResolver && !middleware) return !Object.values(state.slots).some(slot => slot.accessUrl && slot.accessUrl !== slot.url);
  const current = new URL(request.url);
  const visible = new URL(request.originalUrl || request.url);
  const urls = new Map();
  for (const slot of Object.values(state.slots)) {
    if (!urls.has(slot.url) || slot.accessUrl) urls.set(slot.url, slot.accessUrl || slot.url);
  }
  for (const source of Object.values(state.slots).map(slot => slot.source).filter(Boolean)) if (!urls.has(source)) urls.set(source, source);
  // `state.source` is a pathname for tree matching, without search parameters.
  // When a saved branch already covers it, authorize that branch's full access
  // URL rather than also executing its physical path outside the rewrite.
  if (![...urls.keys()].some(saved => new URL(saved, current).pathname === state.source)) urls.set(state.source, state.source);
  if (urls.size > 32) return false;
  const deadline = AbortSignal.timeout(10_000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const headers = new Headers(request.routingRequestHeaders || request.headers || {});
  request.routingContexts = new Map();
  function internal(url) { return removeBasePath(decodeURI(url.pathname), request.basePath) + url.search; }
  function saveContext(saved, url, values) {
    // Rendering separately is needed only for genuinely different contexts.
    const actual = new Headers(request.headers || {});
    if (JSON.stringify([...values].sort()) !== JSON.stringify([...actual].sort()) || url.href !== current.href) {
      request.routingContexts.set(saved, { headers: Object.fromEntries(values), url: url.href, method: 'GET', mutableCookies: false });
    }
  }
  for (const [saved, access] of urls) {
    signal.throwIfAborted();
    const url = new URL(access, current);
    // App route matching decodes segment literals. Apply the same spelling to
    // access checks so an encoded /%61dmin source cannot skip /admin middleware.
    try { url.pathname = decodeURI(url.pathname); } catch { return false; }
    url.pathname = addBasePath(url.pathname, request.basePath);
    // The unmounted root is `/`, while its slash-free mounted spelling is the
    // basePath itself. Do not manufacture a redirect during this translation.
    if (request.basePath && url.pathname === request.basePath + '/' && !request.trailingSlash && !request.skipTrailingSlashRedirect) url.pathname = request.basePath;
    if (request.method !== 'POST' && internal(url) === internal(visible) && internal(new URL(saved, current)) === internal(current)) continue;
    if (request.routingResolver) {
      const result = await nativeResolution(request.routingResolver, url, headers, signal);
      if (!result) return false;
      const effective = new URL(result.resolved.url, current);
      if (internal(effective) !== internal(new URL(saved, current))) return false;
      const transformed = new Headers(result.resolved.headers);
      const cookies = result.responseHeaders?.['set-cookie'];
      if (cookies) {
        const lines = Array.isArray(cookies) ? cookies : [cookies];
        request.responseHeaders ||= {};
        request.responseHeaders['set-cookie'] = [...new Set([...(request.responseHeaders['set-cookie'] || []), ...lines])];
      }
      saveContext(saved, effective, transformed);
      continue;
    }
    if (!middleware.matchers.some(rule => matches(rule, url, headers))) {
      if (internal(url) !== internal(new URL(saved, current))) return false;
      saveContext(saved, url, headers);
      continue;
    }
    // A regular RSC render must not initialize the middleware/Web Request graph.
    const { runMiddleware } = await import('./middleware.mjs');
    const result = await runMiddleware({ modulePath: path.join(request.distDir, middleware.module), middleware,
      manifest: { middleware, config: { basePath: request.basePath, trailingSlash: request.trailingSlash,
        skipProxyUrlNormalize: request.skipProxyUrlNormalize, skipMiddlewareUrlNormalize: request.skipMiddlewareUrlNormalize } }, url: url.href, method: 'GET', headers: Object.fromEntries(headers),
      production: request.production, signal, timeoutMs: 5000 });
    try {
      if (result.status < 200 || result.status >= 300 || result.headers.location || (!result.headers['x-middleware-next'] && !result.headers['x-middleware-rewrite'])) return false;
      const transformed = new Headers(headers);
      const override = result.headers['x-middleware-override-headers'];
      const cookies = result.headers['set-cookie'];
      if ((override || cookies) && !request.routingRequestHeaders) return false;
      if (override !== undefined) {
        const names = new Set(override.split(',').map(name => name.trim().toLowerCase()).filter(Boolean));
        for (const name of [...transformed.keys()]) if (!names.has(name)) transformed.delete(name);
        for (const name of names) {
          const value = result.headers['x-middleware-request-' + name];
          if (value === undefined) transformed.delete(name); else transformed.set(name, value);
        }
      }
      const effective = new URL(result.headers['x-middleware-rewrite'] || url.href, url);
      if (effective.origin !== current.origin || internal(effective) !== internal(new URL(saved, current))) return false;
      if (cookies) {
        const lines = Array.isArray(cookies) ? cookies : [cookies];
        transformed.set('x-middleware-set-cookie', lines.join(','));
        request.responseHeaders ||= {};
        request.responseHeaders['set-cookie'] = [...new Set([...(request.responseHeaders['set-cookie'] || []), ...lines])];
      }
      saveContext(saved, effective, transformed);
    } finally { result.cancel?.(); result.finalizeCache?.(); }
  }
  if (request.routingContexts.size) request.routingContexts.set(internal(current), { headers: request.headers, url: current.href, method: 'GET', mutableCookies: false });
  return true;
}
