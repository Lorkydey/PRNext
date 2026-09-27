'use strict';
const { NextRequest, NextURL } = require('./server.cjs');
const { CookieStore } = require('./cookies.cjs');
const { inCacheScope } = require('./data-cache.cjs');
const { dynamicUsage, forceStaticRender } = require('./static-generation.cjs');

const requestData = new Set(['headers', 'cookies', 'url', 'body', 'blob', 'json', 'text', 'arrayBuffer', 'formData', 'bytes']);
const urlData = new Set(['search', 'searchParams', 'url', 'href', 'origin', 'toJSON', 'toString']);

function reflect(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === 'function' ? value.bind(target) : value;
}

function proxyRouteRequest(request, context) {
  const force = forceStaticRender(context);
  const dynamic = expression => {
    if (inCacheScope()) throw new Error(`${expression} cannot be accessed inside unstable_cache; read it outside and pass the required values as arguments`);
    dynamicUsage(expression, context);
  };
  const emptyHeaders = new Proxy(new Headers(), { get(target, property) {
    if (['set', 'append', 'delete'].includes(property)) return () => { throw new Error('Request headers are read-only in force-static routes'); };
    return reflect(target, property);
  } });
  const emptyCookies = new CookieStore('');
  function proxyUrl(url) {
    const searchParams = new URLSearchParams();
    let proxy;
    proxy = new Proxy(url, { get(target, property) {
      if (property === 'clone') return () => proxyUrl(target.clone());
      if (force) {
        if (property === 'search') return '';
        if (property === 'searchParams') return searchParams;
        if (property === 'url') return undefined;
        if (property === 'href') {
          const canonical = new URL(target.href);
          canonical.host = 'localhost:3000'; canonical.protocol = 'http:'; canonical.search = '';
          return canonical.href;
        }
        if (property === 'toString' || property === 'toJSON') return () => proxy.href;
      } else if (urlData.has(property)) dynamic(`nextUrl.${property}`);
      return reflect(target, property);
    }, set(target, property, value) {
      // Native URL accessors use private slots, so mutations on a cloned
      // nextUrl must use the real URL as their receiver as well as reads.
      return Reflect.set(target, property, value, target);
    } });
    return proxy;
  }
  const nextUrl = proxyUrl(request.nextUrl);
  return new Proxy(request, { get(target, property) {
    if (property === 'nextUrl') return nextUrl;
    if (property === 'clone') return () => proxyRouteRequest(new NextRequest(target.clone(), { nextConfig: target.nextUrl._nextConfig }), context);
    if (force) {
      if (property === 'headers') return emptyHeaders;
      if (property === 'cookies') return emptyCookies;
      if (property === 'url') return nextUrl.href;
      if (property === 'geo' || property === 'ip') return undefined;
    } else if (requestData.has(property)) dynamic(`request.${property}`);
    return reflect(target, property);
  } });
}

module.exports = { proxyRouteRequest };
