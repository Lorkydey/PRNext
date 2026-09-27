'use strict';

function normalizeBasePath(value = '') {
  if (typeof value !== 'string' || (value && (!value.startsWith('/') || value.endsWith('/') || /[?#\\\s\x00-\x1f\x7f-\uffff]/.test(value) || /%(?![\da-f]{2})/i.test(value) || value.split('/').some((part, index) => index && (!part || part === '.' || part === '..'))))) {
    throw new TypeError('basePath must be empty or an absolute path without a trailing slash, query or fragment');
  }
  return value;
}
function hasBasePath(path, basePath = '') {
  const pathname = String(path).split(/[?#]/, 1)[0];
  return !basePath || pathname === basePath || pathname.startsWith(`${basePath}/`);
}
function addBasePath(path, basePath = '') {
  return basePath && String(path).startsWith('/') ? `${basePath}${path}` : path;
}
function removeBasePath(path, basePath = '') {
  if (!basePath || !hasBasePath(path, basePath)) return path;
  const rest = path.slice(basePath.length);
  return !rest || rest[0] === '?' || rest[0] === '#' ? `/${rest}` : rest;
}
function assetBase(basePath = '', assetPrefix = '') {
  return `${(assetPrefix || basePath).replace(/\/$/, '')}/_prnext/assets`;
}
// Same client policy as Next: extension URLs stay slashless. The native
// redirect layer additionally excludes .well-known paths.
function normalizeTrailingSlash(path, { trailingSlash = false, skipTrailingSlashRedirect = false } = {}) {
  if (!String(path).startsWith('/') || String(path).startsWith('//') || skipTrailingSlashRedirect) return path;
  const match = /^([^?#]*)(.*)$/.exec(path);
  const pathname = match[1], rest = match[2];
  const trimmed = pathname.endsWith('/') ? pathname.slice(0, -1) || '/' : pathname;
  return (trailingSlash && !/\.[^/]+\/?$/.test(pathname) ? (pathname.endsWith('/') ? pathname : pathname + '/') : trimmed) + rest;
}
module.exports = { normalizeTrailingSlash, normalizeBasePath, hasBasePath, addBasePath, removeBasePath, assetBase };
