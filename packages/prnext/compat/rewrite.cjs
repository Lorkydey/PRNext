'use strict';

function parseRewrite(source) {
  if (!source) return undefined;
  if (source.length > 256 * 1024) throw new Error('Rewrite metadata exceeds the response limit');
  const value = JSON.parse(source);
  if (!value || typeof value.url !== 'string' || !value.url.startsWith('/') || value.url.startsWith('//') ||
      !value.params || typeof value.params !== 'object' || Array.isArray(value.params)) {
    throw new Error('Invalid rewrite metadata');
  }
  for (const parameter of Object.values(value.params)) {
    if (typeof parameter !== 'string' && !(Array.isArray(parameter) && parameter.every(item => typeof item === 'string'))) {
      throw new Error('Invalid rewrite parameter');
    }
  }
  return value;
}

function readRewriteMarker(document) {
  const marker = document.getElementById('__PRNEXT_REWRITE__');
  if (!marker) return undefined;
  const value = parseRewrite(marker.textContent);
  marker.remove();
  return value;
}

function readRewriteHeader(response) {
  const value = response.headers.get('x-prnext-rewrite');
  return value ? parseRewrite(decodeURIComponent(value)) : undefined;
}

function rewriteQuery(rewrite) {
  const query = Object.create(null);
  for (const [key, value] of new URL(rewrite.url, 'http://prnext.local').searchParams) {
    if (Object.hasOwn(query, key)) query[key] = [...(Array.isArray(query[key]) ? query[key] : [query[key]]), value];
    else query[key] = value;
  }
  return Object.assign(query, rewrite.params);
}

module.exports = { parseRewrite, readRewriteMarker, readRewriteHeader, rewriteQuery };
