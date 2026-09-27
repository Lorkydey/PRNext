import { addBasePath, removeBasePath, hasBasePath, normalizeTrailingSlash } from '../compat/paths.cjs';

function httpURL(value, base) {
  const target = new URL(value, base);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported navigation protocol');
  return target;
}

/** User router hrefs are logical; URL objects and absolute URLs are already public. */
export function publicNavigationURL(value, visibleURL, basePath = '', policy = {}) {
  if (value instanceof URL || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return httpURL(value, visibleURL);
  const internal = httpURL(visibleURL);
  internal.pathname = removeBasePath(internal.pathname, basePath);
  const target = httpURL(value, internal);
  target.pathname = addBasePath(target.pathname, basePath);
  if (basePath && target.pathname === `${basePath}/` && !policy.trailingSlash && !policy.skipTrailingSlashRedirect) target.pathname = basePath;
  target.pathname = normalizeTrailingSlash(target.pathname, policy);
  return target;
}

export function isApplicationURL(target, origin, basePath = '') {
  return target.origin === origin && hasBasePath(target.pathname, basePath);
}

/** A document redirect may leave the site; Flight must stay on this origin. */
export function flightResponseURL(response, requested) {
  const source = httpURL(requested);
  const target = httpURL(response.url || source.href, source);
  if (target.origin !== source.origin) throw new Error('Cross-origin navigation requires a document request');
  // Fetch omits the request fragment. Keep it unless a final URL supplies one.
  if (!target.hash) target.hash = source.hash;
  return target;
}

/** Data redirects carry a public destination instead of a fetch-follow Location. */
export function pageDataRedirectURL(response, visibleURL) {
  const target = response.headers.get('x-nextjs-redirect') ||
    ([301, 302, 303, 307, 308].includes(response.status) ? response.headers.get('location') : null);
  return target === null ? null : httpURL(target, visibleURL);
}
