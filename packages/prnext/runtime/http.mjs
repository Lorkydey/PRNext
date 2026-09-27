import { IncomingMessage, validateHeaderName, validateHeaderValue } from 'node:http';
import { Duplex, Writable } from 'node:stream';
import { revalidatePage } from './pages-revalidate.mjs';
import { currentRequest } from '../compat/headers.cjs';
import { draftCookie } from '../compat/draft.cjs';
import { previewCookies, NAME as PREVIEW_COOKIE } from '../compat/preview.cjs';
import { serializeCookie } from '../compat/cookies.cjs';

export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const forbiddenHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function serializeData(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' })[character]);
}

export function queryFromUrl(url, params = {}) {
  const query = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(query, key)) query[key] = [...(Array.isArray(query[key]) ? query[key] : [query[key]]), value];
    else query[key] = value;
  }
  return Object.assign(query, params);
}

function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}

export function createRequest({ url, originalUrl, method = 'GET', headers = {}, body = '', params = {} }) {
  const parsed = new URL(url, 'http://localhost');
  const visible = originalUrl ? new URL(originalUrl, parsed) : parsed;
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  socket.remoteAddress = '127.0.0.1';
  const request = new IncomingMessage(socket);
  request.method = method;
  request.url = `${visible.pathname}${visible.search}`;
  request.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  request.rawHeaders = Object.entries(request.headers).flatMap(([name, value]) => [name, String(value)]);
  request.httpVersion = '1.1';
  request.query = queryFromUrl(parsed, params);
  request.cookies = parseCookies(request.headers.cookie);
  request.params = params;
  request.complete = true;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || '', 'base64');
  if (bytes.length) request.push(bytes);
  request.push(null);
  return { request, bytes, url: parsed };
}

export class CapturedResponse extends Writable {
  constructor(options, canRevalidate = false) {
    super(options);
    this._canRevalidate = canRevalidate;
    this.statusCode = 200;
    this.statusMessage = '';
    this.headersSent = false;
    this._headers = Object.create(null);
    this._chunks = [];
    this._size = 0;
    // renderPage can consume res.end() synchronously before the stream emits error.
    // Keep errors observable through .errored/.result() without an unhandled event.
    this.on('error', () => {});
  }
  _write(chunk, _encoding, callback) {
    this._size += chunk.byteLength;
    if (this._size > MAX_RESPONSE_BYTES) { callback(new Error('Response exceeds the 16 MiB PRNext limit')); return; }
    this.headersSent = true;
    this._chunks.push(Buffer.from(chunk));
    callback();
  }
  get finished() { return this.writableEnded; }
  setHeader(name, value) {
    if (this.headersSent) throw new Error('Cannot set headers after they are sent');
    validateHeaderName(name);
    const normalized = Array.isArray(value) ? value.map(String) : String(value);
    for (const item of Array.isArray(normalized) ? normalized : [normalized]) validateHeaderValue(name, item);
    this._headers[name.toLowerCase()] = normalized;
    return this;
  }
  getHeader(name) { return this._headers[String(name).toLowerCase()]; }
  getHeaders() { return { ...this._headers }; }
  getHeaderNames() { return Object.keys(this._headers); }
  hasHeader(name) { return Object.hasOwn(this._headers, String(name).toLowerCase()); }
  removeHeader(name) {
    if (this.headersSent) throw new Error('Cannot remove headers after they are sent');
    delete this._headers[String(name).toLowerCase()];
  }
  appendHeader(name, value) {
    const existing = this.getHeader(name);
    return this.setHeader(name, [...(existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]), ...(Array.isArray(value) ? value : [value])]);
  }
  writeHead(statusCode, statusMessage, headers) {
    this.status(statusCode);
    if (typeof statusMessage === 'string') this.statusMessage = statusMessage;
    else headers = statusMessage;
    if (Array.isArray(headers)) {
      for (let i = 0; i < headers.length; i += 2) this.appendHeader(headers[i], headers[i + 1]);
    } else {
      for (const [name, value] of Object.entries(headers || {})) this.setHeader(name, value);
    }
    this.headersSent = true;
    return this;
  }
  flushHeaders() { this.headersSent = true; }
  status(code) {
    if (!Number.isInteger(code) || code < 100 || code > 599) throw new TypeError('Invalid HTTP status code');
    this.statusCode = code;
    return this;
  }
  setDraftMode({ enable = true } = {}) {
    if (typeof enable !== 'boolean') throw new TypeError('setDraftMode enable must be a boolean');
    const context = currentRequest();
    this.appendHeader('set-cookie', serializeCookie(draftCookie(context, enable, { keepValue: true })));
    this.setHeader('cache-control', 'private, no-cache, no-store, max-age=0');
    context.draftChanged = true;
    return this;
  }
  clearPreviewData({ path = '/' } = {}) {
    const context = currentRequest();
    this.appendHeader('set-cookie', serializeCookie(draftCookie(context, false, { path })));
    this.appendHeader('set-cookie', serializeCookie({ ...draftCookie(context, false, { path }), name: PREVIEW_COOKIE }));
    this.setHeader('cache-control', 'private, no-cache, no-store, max-age=0');
    context.draftChanged = true;
    return this;
  }
  setPreviewData(data, options) {
    const context = currentRequest();
    const cookies = previewCookies(context, data, options);
    for (const cookie of cookies) this.appendHeader('set-cookie', serializeCookie(cookie));
    this.setHeader('cache-control', 'private, no-cache, no-store, max-age=0');
    context.draftChanged = true;
    return this;
  }
  json(value) {
    this.setHeader('content-type', 'application/json; charset=utf-8');
    return this.end(JSON.stringify(value));
  }
  send(value) {
    if (value === null || value === undefined) return this.end();
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      if (!this.hasHeader('content-type')) this.setHeader('content-type', 'application/octet-stream');
      return this.end(value);
    }
    if (typeof value === 'object' || typeof value === 'boolean' || typeof value === 'number') return this.json(value);
    if (!this.hasHeader('content-type')) this.setHeader('content-type', 'text/html; charset=utf-8');
    return this.end(String(value));
  }
  redirect(code, destination) {
    if (typeof code === 'string') { destination = code; code = 307; }
    this.status(code);
    this.setHeader('location', destination);
    return this.end(destination);
  }
  revalidate(path, options) { return revalidatePage(this, path, options); }
  end(chunk, encoding, callback) {
    this.headersSent = true;
    return super.end(chunk, encoding, callback);
  }
  result() {
    if (this.errored) throw this.errored;
    if (!Number.isInteger(this.statusCode) || this.statusCode < 100 || this.statusCode > 599) throw new Error('Invalid response status');
    const headers = Object.fromEntries(Object.entries(this._headers).filter(([name]) => !forbiddenHeaders.has(name) && name !== 'content-length').map(([name, value]) => [name, Array.isArray(value) ? [...value] : value]));
    return { status: this.statusCode, headers, body: [204, 205, 304].includes(this.statusCode) ? Buffer.alloc(0) : Buffer.concat(this._chunks) };
  }
}

export function plainResponse(status, message) {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(message) };
}

export function errorResponse(error, production = process.env.NODE_ENV === 'production') {
  console.error('[prnext]', error?.stack || error);
  const status = [400, 504].includes(error?.statusCode) ? error.statusCode : 500;
  const message = status === 400 ? 'Bad Request' : status === 504 ? 'Gateway Timeout' : 'Internal Server Error';
  return plainResponse(status, production || status === 400 ? message : String(error?.stack || error));
}
