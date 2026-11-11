'use strict';

// Flight chunk identifiers are opaque strings. Carry only the referenced
// module's public URL instead of embedding every route's import table.
const PREFIX = 'prnext-client-v1:';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
function clientChunk(id, url) {
  if (!ID.test(id) || typeof url !== 'string' || !url || url.length > 4096) throw new Error('Invalid PRNext client reference');
  return PREFIX + id + ':' + url;
}
function readClientChunk(value, assetBase, documentUrl) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const separator = value.indexOf(':', PREFIX.length);
  const id = value.slice(PREFIX.length, separator), source = value.slice(separator + 1);
  if (separator < 0 || !ID.test(id) || !source || source.length > 4096 || !assetBase) throw new Error('Invalid PRNext client reference');
  const base = new URL(assetBase, documentUrl), url = new URL(source, documentUrl);
  const directory = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  const file = url.pathname.slice(directory.length);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password ||
      url.search || url.hash || !url.pathname.startsWith(directory) || !file.startsWith(id + '-') ||
      !/^[A-Za-z0-9_-]+\.js$/.test(file)) throw new Error('Untrusted PRNext client reference');
  return { id, url: url.href };
}
module.exports = { clientChunk, readClientChunk };
