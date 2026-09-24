'use strict';

function parseCookieHeader(value = '') {
  const values = new Map();
  for (const part of String(value).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    let value = part.slice(separator + 1).trim();
    try { value = decodeURIComponent(value); } catch { /* Preserve malformed user input. */ }
    values.set(name, { name, value });
  }
  return values;
}

function serializeCookie(cookie) {
  const { name, value = '', path = '/', domain, expires, maxAge, httpOnly, secure, sameSite, priority, partitioned } = cookie;
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new TypeError('Invalid cookie name');
  const result = [`${name}=${encodeURIComponent(String(value))}`];
  for (const [key, attribute] of [['Path', path], ['Domain', domain]]) {
    if (attribute !== undefined && attribute !== false) {
      if (/[;\r\n\u0000]/.test(String(attribute))) throw new TypeError(`Invalid cookie ${key}`);
      result.push(`${key}=${attribute}`);
    }
  }
  if (expires !== undefined) {
    const date = expires instanceof Date ? expires : new Date(expires);
    if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid cookie expiry');
    result.push(`Expires=${date.toUTCString()}`);
  }
  if (maxAge !== undefined) {
    if (!Number.isFinite(maxAge)) throw new TypeError('Invalid cookie maxAge');
    result.push(`Max-Age=${Math.floor(maxAge)}`);
  }
  if (httpOnly) result.push('HttpOnly');
  if (secure) result.push('Secure');
  if (sameSite) {
    const normalized = sameSite === true ? 'strict' : String(sameSite).toLowerCase();
    if (!['lax', 'strict', 'none'].includes(normalized)) throw new TypeError('Invalid cookie sameSite');
    result.push(`SameSite=${normalized[0].toUpperCase()}${normalized.slice(1)}`);
  }
  if (priority) {
    const normalized = String(priority).toLowerCase();
    if (!['low', 'medium', 'high'].includes(normalized)) throw new TypeError('Invalid cookie priority');
    result.push(`Priority=${normalized[0].toUpperCase()}${normalized.slice(1)}`);
  }
  if (partitioned) result.push('Partitioned');
  return result.join('; ');
}

function parseResponseCookie(header) {
  const [pair, ...attributes] = header.split(';');
  const cookie = parseCookieHeader(pair).values().next().value;
  if (!cookie) return;
  for (const attribute of attributes) {
    const separator = attribute.indexOf('=');
    const key = (separator < 0 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
    const value = separator < 0 ? '' : attribute.slice(separator + 1).trim();
    if (['path', 'domain'].includes(key)) cookie[key] = value;
    else if (key === 'expires') {
      const date = new Date(value);
      if (Number.isFinite(date.getTime())) cookie.expires = date;
    } else if (key === 'max-age' && /^-?\d+$/.test(value)) cookie.maxAge = Number(value);
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'secure' || key === 'partitioned') cookie[key] = true;
    else if (key === 'samesite' && ['strict', 'lax', 'none'].includes(value.toLowerCase())) cookie.sameSite = value.toLowerCase();
    else if (key === 'priority' && ['low', 'medium', 'high'].includes(value.toLowerCase())) cookie.priority = value.toLowerCase();
  }
  return cookie;
}

class CookieStore {
  constructor(header, { mutable = false, onChange } = {}) {
    this._cookies = parseCookieHeader(header);
    this._mutable = mutable;
    this._onChange = onChange;
  }
  get size() { return this._cookies.size; }
  get(name) { const value = this._cookies.get(typeof name === 'object' ? name.name : name); return value && { ...value }; }
  getAll(name) { return [...this._cookies.values()].filter(cookie => !name || cookie.name === (typeof name === 'object' ? name.name : name)).map(cookie => ({ ...cookie })); }
  has(name) { return this._cookies.has(name); }
  set(name, value, options = {}) {
    if (!this._mutable) throw new Error('Cookies can only be modified in a Route Handler or Server Action');
    const cookie = typeof name === 'object' ? { ...name } : { ...options, name, value };
    serializeCookie(cookie);
    this._cookies.set(cookie.name, cookie);
    this._onChange?.(cookie, false);
    return this;
  }
  delete(name) {
    if (!this._mutable) throw new Error('Cookies can only be modified in a Route Handler or Server Action');
    const cookie = typeof name === 'object' ? name : { name };
    this._cookies.delete(cookie.name);
    this._onChange?.({ ...cookie, value: '', expires: new Date(0), maxAge: 0 }, true);
    return this;
  }
  clear() { for (const name of this._cookies.keys()) this.delete(name); return this; }
  toString() { return [...this._cookies.values()].map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; '); }
  *[Symbol.iterator]() { for (const [name, cookie] of this._cookies) yield [name, { ...cookie }]; }
}

class ResponseCookieStore extends CookieStore {
  constructor(headers) {
    super('', { mutable: true });
    this._headers = headers;
    for (const header of headers.getSetCookie()) {
      const cookie = parseResponseCookie(header);
      if (cookie) this._cookies.set(cookie.name, cookie);
    }
    this._onChange = () => {
      headers.delete('set-cookie');
      for (const cookie of this._cookies.values()) headers.append('set-cookie', serializeCookie(cookie));
    };
  }
  set(name, value, options = {}) {
    const cookie = typeof name === 'object' ? { ...name } : { ...options, name, value };
    cookie.path ??= '/';
    if (typeof cookie.expires === 'number') cookie.expires = new Date(cookie.expires);
    if (cookie.maxAge) cookie.expires = new Date(Date.now() + cookie.maxAge * 1000);
    return super.set(cookie);
  }
  delete(name) {
    const cookie = typeof name === 'object' ? name : { name };
    return this.set({ ...cookie, value: '', expires: new Date(0) });
  }
  toString() { return [...this._cookies.values()].map(serializeCookie).join('; '); }
}

module.exports = { CookieStore, ResponseCookieStore, parseCookieHeader, serializeCookie };
