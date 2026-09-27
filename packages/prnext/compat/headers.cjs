'use strict';
const {sampleMethods} = require('./instant-samples.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { CookieStore, parseCookieHeader, serializeCookie } = require('./cookies.cjs');
const { createCacheState, inCacheScope, currentCacheScope } = require('./data-cache.cjs');
const { createStaticState, dynamicUsage, forceStaticRender } = require('./static-generation.cjs');
const { isDraftRequest, draftCookie } = require('./draft.cjs');
const { readPreviewData } = require('./preview.cjs');
const { staticBailout } = require('./static-generation.cjs');

const requestStorage = new AsyncLocalStorage();
function currentRequest() {
  const context = requestStorage.getStore();
  if (!context) throw new Error('Request APIs can only be used while handling a PRNext request');
  return context;
}
function runWithoutRequestContext(callback) { return requestStorage.exit(callback); }

function readonlyHeaders(values) {
  const headers = new Headers(values);
  const proxy = new Proxy(headers, { get(target, property) {
    if (['set', 'append', 'delete'].includes(property)) return () => { throw new Error('headers() is read-only'); };
    if (property === 'forEach') return (callback, thisArg) => target.forEach((value, name) => callback.call(thisArg, value, name, proxy));
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return proxy;
}

function runRequestContext(input, callback) {
  const lazy = input.phase === 'pages' && (!input.headers || [Object.prototype, null].includes(Object.getPrototypeOf(input.headers)));
  // Snapshot values now, preserving readonly request semantics even when the
  // caller subsequently mutates its input. Pages APIs normally never need the
  // Web Headers/CookieStore objects, so construct those only on actual access.
  const raw = lazy ? Object.create(null) : undefined;
  if (lazy && !forceStaticRender(input)) for (const name of Object.keys(input.headers || {})) raw[name] = String(input.headers[name]);
  let headers = lazy ? undefined : readonlyHeaders(forceStaticRender(input) ? {} : input.headers || {});
  const getHeaders = () => headers ??= readonlyHeaders(raw);
  const outgoingCookies = new Map();
  const mutableCookies = Boolean(input.mutableCookies) && !forceStaticRender(input);
  const makeCookies = () => new CookieStore(getHeaders().get('cookie') || '', {
    mutable: mutableCookies,
    onChange(cookie) { outgoingCookies.set(cookie.name, serializeCookie(cookie)); },
  });
  let cookies = lazy ? undefined : makeCookies();
  const getCookies = () => cookies ??= makeCookies();
  // Next merges this trusted middleware response marker only into App render
  // and action cookies. Request headers, Route Handlers and Pages APIs retain
  // their original Cookie header. Native ingress strips spoofed markers.
  if (['render', 'action'].includes(input.phase) && !forceStaticRender(input)) {
    const marker = headers.get('x-middleware-set-cookie');
    for (const line of marker?.split(/,(?=\s*[^;,=\s]+\s*=)/) || []) {
      for (const [name, cookie] of parseCookieHeader(line.split(';', 1)[0])) cookies._cookies.set(name, cookie);
    }
  }
  const context = { ...input, previewData: readPreviewData(input), draftMode: isDraftRequest(input), basePath: input.basePath ?? input.manifest?.config?.basePath ?? '', cacheState: input.cacheState || createCacheState(),
    staticState: input.staticState || (input.staticGeneration ? createStaticState(input.staticGeneration, input.cacheConfig) : undefined),
    headers, cookies, outgoingCookies };
  if (lazy) Object.defineProperties(context, {
    headers: { enumerable: true, configurable: true, get: getHeaders, set(value) { headers = value; } },
    cookies: { enumerable: true, configurable: true, get: getCookies, set(value) { cookies = value; } },
  });
  return requestStorage.run(context, callback);
}

function assertUncached(name) {
  if (inCacheScope()) throw new Error(`${name}() cannot be accessed inside unstable_cache; read it outside and pass the required values as arguments`);
}
async function headers() { if (currentRequest().instantValidation && currentRequest().instantSample) { assertUncached('headers'); return sampleMethods(currentRequest(), 'headers', currentRequest().headers); } if (currentCacheScope()?.kind !== 'private') assertUncached('headers'); dynamicUsage('headers()'); return currentRequest().headers; }
async function cookies() { if (currentRequest().instantValidation && currentRequest().instantSample) { assertUncached('cookies'); return sampleMethods(currentRequest(), 'cookies', currentRequest().cookies); } if (currentCacheScope()?.kind !== 'private') assertUncached('cookies'); dynamicUsage('cookies()'); return currentRequest().cookies; }
async function draftMode() {
  const context = currentRequest();
  if (!context.draftProvider) context.draftProvider = {
    get isEnabled() { return context.draftMode; },
    enable() { change(true); },
    disable() { change(false); },
  };
  function change(enabled) {
    assertUncached('draftMode().enable()/disable()');
    if (context.staticState) staticBailout('draftMode().enable()/disable()', context);
    // CookieStore rejects render-phase writes and writes after headers commit.
    context.cookies.set(draftCookie(context, enabled));
    context.draftMode = enabled;
    context.draftChanged = true;
  }
  return context.draftProvider;
}

module.exports = { headers, cookies, draftMode, runRequestContext, currentRequest, runWithoutRequestContext };
