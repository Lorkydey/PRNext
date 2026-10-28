'use strict';
const { RequestCookieStore, ResponseCookieStore } = require('./cookies.cjs');
const { hasBasePath, addBasePath, removeBasePath } = require('./paths.cjs');
const { localePath, withLocale } = require('./locale.cjs');

function middlewareHeaders(init, headers) {
  if (!init?.request?.headers) return;
  if (!(init.request.headers instanceof Headers)) throw new TypeError('request.headers must be an instance of Headers');
  const names = [];
  for (const [name, value] of init.request.headers) {
    headers.set(`x-middleware-request-${name}`, value);
    names.push(name);
  }
  headers.set('x-middleware-override-headers', names.join(','));
}

function nextDataPath(pathname) {
  const match = /^\/_next\/data\/([^/]+)\/(.*)\.json$/.exec(pathname);
  if (!match) return { pathname };
  const parts = match[2].split('/');
  return { buildId: match[1], pathname: parts[0] === 'index' ? '/' : '/' + parts.join('/') };
}

class NextURL extends URL {
  constructor(input, baseOrOptions, options) {
    const base = typeof baseOrOptions === 'string' || baseOrOptions instanceof URL ? baseOrOptions : undefined;
    const config = options || (base ? {} : baseOrOptions) || {};
    super(input, base || config.base);
    this._nextConfig = config.nextConfig || {};
    this._forceLocale = config.forceLocale === true;
    this._parseData = !(this._nextConfig.skipProxyUrlNormalize ?? this._nextConfig.skipMiddlewareUrlNormalize);
    this._trailingSlash = super.pathname === '/' ? !!this._nextConfig.trailingSlash : super.pathname.endsWith('/');
    this._basePath = hasBasePath(super.pathname, this._nextConfig.basePath) ? this._nextConfig.basePath || '' : '';
    const logical = this._parseData ? nextDataPath(removeBasePath(super.pathname, this._basePath)) : { pathname: removeBasePath(super.pathname, this._basePath) };
    this._buildId = logical.buildId;
    this._locale = this._nextConfig.i18n ? localePath(logical.pathname, {...this._nextConfig.i18n,defaultLocale:this.defaultLocale}).locale : '';
  }
  get pathname() {
    const raw = removeBasePath(super.pathname, this._basePath);
    return localePath(this._parseData ? nextDataPath(raw).pathname : raw, this._nextConfig.i18n).pathname;
  }
  set pathname(value) { super.pathname = addBasePath(withLocale(String(value).startsWith('/') ? value : `/${value}`, this._locale, this.defaultLocale), this._basePath); }
  get defaultLocale() { return this.domainLocale?.defaultLocale || this._nextConfig.i18n?.defaultLocale; }
  get domainLocale() { return this._nextConfig.i18n?.domains?.find(value=>value.domain.toLowerCase()===this.host.toLowerCase()); }
  get locale() { return this._locale; }
  get buildId() { return this._buildId; }
  set buildId(value) { this._buildId = value; }
  set locale(value) {
    if (!this._nextConfig.i18n?.locales.includes(value)) throw new TypeError(`Unknown locale: ${value}`);
    const pathname=this.pathname;this._locale=value;this.pathname=pathname;
  }
  get basePath() { return this._basePath; }
  set basePath(value) {
    const pathname = this.pathname;
    this._basePath = value.startsWith('/') ? value : `/${value}`;
    this.pathname = pathname;
  }
  get trailingSlash() { return this._trailingSlash; }
  set trailingSlash(value) { this._trailingSlash = value; }
  get href() {
    const url = new URL(super.href);
    let pathname = withLocale(this.pathname, this._locale, this._buildId || this._forceLocale ? undefined : this.defaultLocale);
    if (this._buildId) {
      pathname = pathname.replace(/\/$/, '');
      pathname = '/_next/data/' + this._buildId + pathname + (this.pathname === '/' ? '/index.json' : '.json');
    }
    url.pathname = addBasePath(pathname, this._basePath);
    if (this._trailingSlash && !this._buildId) { if (!url.pathname.endsWith('/')) url.pathname += '/'; }
    else if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
    return url.href;
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
  set href(value) {
    super.href = value;
    this._trailingSlash = super.pathname === '/' ? !!this._nextConfig.trailingSlash : super.pathname.endsWith('/');
    this._basePath = hasBasePath(super.pathname, this._nextConfig.basePath) ? this._nextConfig.basePath || '' : '';
    const logical = this._parseData ? nextDataPath(removeBasePath(super.pathname, this._basePath)) : { pathname: removeBasePath(super.pathname, this._basePath) };
    this._buildId = logical.buildId;
    this._locale = this._nextConfig.i18n ? localePath(logical.pathname, {...this._nextConfig.i18n,defaultLocale:this.defaultLocale}).locale : '';
  }
  clone() { return new NextURL(this.href, { nextConfig: this._nextConfig, forceLocale: this._forceLocale }); }
}

class NextRequest extends Request {
  constructor(input, init) {
    super(input, init);
    this.nextUrl = new NextURL(this.url, { nextConfig: init?.nextConfig || input?.nextUrl?._nextConfig });
    this.cookies = new RequestCookieStore(this.headers);
  }
}

class NextResponse extends Response {
  constructor(body, init) {
    super(body, init);
    this.cookies = new ResponseCookieStore(this.headers);
    const update = this.cookies._onChange;
    this.cookies._onChange = () => {
      update();
      this.headers.set('x-middleware-set-cookie', this.headers.getSetCookie().join(','));
    };
  }
  static json(value, init) {
    const response = Response.json(value, init);
    return new NextResponse(response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  static redirect(url, init = 307) {
    const options = typeof init === 'number' ? { status: init } : { ...init };
    const status = options.status ?? 307;
    if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError('Invalid redirect status');
    const headers = new Headers(options.headers);
    headers.set('location', new URL(url).href);
    return new NextResponse(null, { ...options, status, headers });
  }
  static next(init) {
    const headers = new Headers(init?.headers);
    headers.set('x-middleware-next', '1');
    middlewareHeaders(init, headers);
    return new NextResponse(null, { ...init, headers });
  }
  static rewrite(destination, init) {
    const headers = new Headers(init?.headers);
    headers.set('x-middleware-rewrite', new URL(destination).href);
    middlewareHeaders(init, headers);
    return new NextResponse(null, { ...init, headers });
  }
}

module.exports = { NextRequest, NextResponse, NextURL };
