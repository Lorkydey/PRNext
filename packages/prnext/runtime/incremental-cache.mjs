import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import legacy from '../compat/incremental-cache.cjs';

const MAX_BYTES = 16 * 1024 * 1024;
const kinds = new Set(['PAGES', 'APP_PAGE', 'APP_ROUTE']);
const empty = status => ({ status, headers: {}, body: Buffer.alloc(0) });
function bytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength > MAX_BYTES) throw new Error('Invalid incremental cache bytes');
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}
async function file(filename) {
  if (typeof filename !== 'string') throw new Error('Missing incremental cache file');
  if ((await stat(filename)).size > MAX_BYTES) throw new Error('Incremental cache file exceeds 16 MiB');
  const value = await readFile(filename);
  if (value.length > MAX_BYTES) throw new Error('Incremental cache file exceeds 16 MiB');
  return value;
}
function metadata(value) {
  const info = value?._prnext;
  if (!info || info.version !== 1 || !Array.isArray(info.tags) || !Array.isArray(info.paths) ||
      (info.revalidate !== false && (!Number.isInteger(info.revalidate) || info.revalidate < 0))) throw new Error('Invalid incremental cache metadata');
  if (info.tags.length > 128 || info.paths.length > 128 || [...info.tags, ...info.paths].some(tag => typeof tag !== 'string' || tag.length > 8192)) throw new Error('Invalid incremental cache associations');
  if (Buffer.byteLength(JSON.stringify(info)) > 48 * 1024) throw new Error('Incremental cache metadata exceeds its budget');
  return info;
}
function implicit(paths = []) {
  return paths.map(value => { const separator = value.indexOf(':'); return '_N_T_' + value.slice(separator + 1).replace(/\/$/, '') + '/' + value.slice(0, separator); });
}

/** Private worker operation. Rust still owns admission, routing, file pairs and transport. */
export async function runIncrementalCache(options) {
  if (!options.manifest?.config?.cacheHandler) throw new Error('No incremental cache handler configured');
  if (typeof options.body !== 'string' || options.body.length > 256 * 1024) throw new Error('Invalid incremental cache operation');
  const input = JSON.parse(Buffer.from(options.body, 'base64').toString());
  if (!input || typeof input.key !== 'string' || input.key.length > 8192 || !kinds.has(input.kind)) throw new Error('Invalid incremental cache key or kind');
  const context = { ...options, cacheHandler: options.manifest.config.cacheHandler, cacheMaxMemorySize: options.manifest.config.cacheMaxMemorySize };
  if (input.op === 'invalidate') {
    await legacy.invalidate(context, { tags: input.tags, mode: 'expire' });
    return empty(204);
  }
  if (input.op === 'set') {
    const html = await file(input.htmlFile);
    const data = input.kind === 'APP_ROUTE' ? Buffer.alloc(0) : await file(input.dataFile);
    if (html.length + data.length > MAX_BYTES) return empty(413);
    const info = { version: 1, revalidate: input.revalidate, tags: input.tags || [], paths: input.paths || [] };
    const value = { kind: input.kind, headers: input.headers || {}, status: input.status, _prnext: info };
    metadata(value);
    if (input.kind === 'APP_ROUTE') value.body = html;
    else {
      value.html = html.toString();
      if (input.kind === 'APP_PAGE') value.rscData = data;
      else value.pageData = JSON.parse(data.toString());
    }
    const tags = [...new Set([...info.tags, ...implicit(info.paths)])];
    if (tags.length) value.headers = { ...value.headers, 'x-next-cache-tags': tags.join(',') };
    await legacy.setEntry(input.key, value, context, { tags, cacheControl: { revalidate: info.revalidate }, isRoutePPREnabled: false });
    return empty(204);
  }
  if (input.op !== 'get') throw new Error('Unknown incremental cache operation');
  const entry = await legacy.getEntry(input.key, input.kind, context, { tags: input.tags || [], softTags: implicit(input.paths) });
  if (!entry?.value) return empty(204);
  const value = entry.value;
  if (value.kind !== input.kind || typeof entry.lastModified !== 'number' || !Number.isFinite(entry.lastModified) || entry.lastModified < -1 || entry.lastModified > Date.now() + 60_000) throw new Error('Invalid incremental cache entry');
  const info = metadata(value);
  if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599) throw new Error('Invalid incremental cached status');
  if (!value.headers || typeof value.headers !== 'object' || Array.isArray(value.headers) || Buffer.byteLength(JSON.stringify(value.headers)) > 48 * 1024) throw new Error('Invalid incremental cached headers');
  let html, data = Buffer.alloc(0);
  if (input.kind === 'APP_ROUTE') html = bytes(value.body);
  else {
    if (typeof value.html !== 'string' || Buffer.byteLength(value.html) > MAX_BYTES) throw new Error('Invalid incremental cached HTML');
    html = Buffer.from(value.html);
    data = input.kind === 'APP_PAGE' ? bytes(value.rscData) : Buffer.from(JSON.stringify(value.pageData));
  }
  if (html.length + data.length > MAX_BYTES) throw new Error('Incremental cache entry exceeds 16 MiB');
  const cacheVersion = createHash('sha256').update(JSON.stringify([entry.lastModified, value.status, value.headers, info])).update(html).update(data).digest('hex');
  if (input.knownVersion === cacheVersion) return { ...empty(304), headers: { 'x-prnext-cache-version': cacheVersion } };
  const headers = { ...value.headers }; delete headers['x-next-cache-tags'];
  return { status: value.status, headers, body: [html, data],
    isr: { ...(input.kind === 'APP_ROUTE' ? { kind: 'route' } : {}), revalidate: entry.lastModified < 0 ? 0 : info.revalidate,
      htmlLength: html.length, dataLength: data.length, tags: info.tags, paths: info.paths,
      lastModified: entry.lastModified, cacheVersion } };
}
