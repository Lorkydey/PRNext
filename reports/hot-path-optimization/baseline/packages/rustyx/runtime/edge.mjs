import { AsyncLocalStorage } from 'node:async_hooks';
import { runInContext } from 'node:vm';
import { createRequire } from 'node:module';
import * as headerApi from '../compat/headers.cjs';
import * as cacheApi from '../compat/cache.cjs';
import * as navigationApi from '../compat/navigation-server.cjs';
import { connection } from '../compat/server.cjs';

function responseHeaders(headers) {
  const values = [...headers].filter(([name]) => name.toLowerCase() !== 'set-cookie');
  for (const cookie of headers.getSetCookie()) values.push(['set-cookie', cookie]);
  return values;
}

function responseMetadata(target, source) {
  const metadata = { url: source.url, redirected: source.redirected, type: source.type };
  const clone = target.clone;
  Object.defineProperties(target, {
    ...Object.fromEntries(Object.entries(metadata).map(([name, value]) => [name, { value, configurable: true }])),
    clone: { configurable: true, value() { return responseMetadata(Reflect.apply(clone, this, []), metadata); } },
  });
  return target;
}

const reactVMs = new Map();

async function createEdgeVM(reactMode) {
  const vendor = await import('@edge-runtime/vm');
  const { EdgeVM } = vendor.default || vendor;
  const react = {}, framework = {};
  if (reactMode) {
    const require = createRequire(import.meta.url);
    for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom']) react[name] = require(name);
    if (reactMode === 'rsc') react['react-server-dom-webpack/server'] = Object.fromEntries(['registerClientReference', 'registerServerReference'].map(name => [name, require('react-server-dom-webpack/server.node')[name]]));
    if (reactMode === 'rsc') framework['app-dynamic'] = require('../compat/app-dynamic.cjs');
    if (reactMode === 'ssr') for (const name of ['link', 'image', 'head', 'router', 'compat-router', 'next-router-context', 'next-app-router-context', 'navigation', 'script', 'app-context', 'app-layout-context', 'app-navigation-boundary', 'app-client-page', 'app-error-boundary', 'app-dynamic']) framework[name] = require('../compat/' + name + '.cjs');
  }
  const actionHelpers = reactMode ? { 'action-crypto': await import('./action-crypto.mjs'), 'action-ssr': await import('./action-ssr.mjs') } : {};
  return new EdgeVM({ codeGeneration: { strings: false, wasm: false }, extend(context) {
    context.process = { env: { ...process.env, NEXT_RUNTIME: 'edge' } };
    context.AsyncLocalStorage = AsyncLocalStorage;
    if (reactMode) {
      context.__RUSTYX_EDGE_REACT = react;
      context.__RUSTYX_EDGE_ACTIONS = actionHelpers;
      context.__RUSTYX_EDGE_FRAMEWORK = framework;
      // React's host Flight serializer recognizes these Web value types by
      // constructor identity; keep their semantics across the two realms.
      Object.assign(context, { Date, Map, Set, FormData, ArrayBuffer, Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView,
        Error, TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError, AggregateError });
    }
    context.__RUSTYX_EDGE_HOST = {
      headers: { headers: async () => {
        const values = new context.Headers(await headerApi.headers());
        return new Proxy(values, { get(target, key) {
          if (['set', 'append', 'delete'].includes(key)) return () => { throw new Error('Headers cannot be modified'); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }, cookies: headerApi.cookies, draftMode: headerApi.draftMode },
      cache: { revalidateTag: cacheApi.revalidateTag, revalidatePath: cacheApi.revalidatePath, unstable_noStore: cacheApi.unstable_noStore },
      navigation: { redirect: navigationApi.redirect, permanentRedirect: navigationApi.permanentRedirect,
        notFound: navigationApi.notFound, RedirectType: navigationApi.RedirectType, unstable_rethrow: navigationApi.unstable_rethrow },
      server: { connection },
    };
    context.fetch = async (input, init) => {
      if (input instanceof context.Request) input = new Request(input.url, { method: input.method, headers: [...input.headers], body: input.body, signal: input.signal, duplex: 'half',
        cache: input.cache, credentials: input.credentials, mode: input.mode, redirect: input.redirect, referrer: input.referrer, referrerPolicy: input.referrerPolicy, integrity: input.integrity });
      const response = await fetch(input, init);
      return responseMetadata(new context.Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) }), response);
    };
    return context;
  } });
}

export async function loadEdgeModule(code, name, reactMode) {
  if (reactMode !== undefined && reactMode !== 'rsc' && reactMode !== 'ssr') throw new Error('Unknown Edge React mode');
  let pending;
  if (reactMode) {
    pending = reactVMs.get(reactMode);
    if (!pending) {
      pending = createEdgeVM(reactMode);
      reactVMs.set(reactMode, pending);
      void pending.catch(() => { if (reactVMs.get(reactMode) === pending) reactVMs.delete(reactMode); });
    }
  } else pending = createEdgeVM();
  // This runtime module belongs to one compiled build. Its two React realms
  // are shared lazily by all pages/boundaries; each bundle has its own factory.
  const vm = await pending;
  const module = await runInContext(code, vm.context, { filename: name, timeout: 5000 });
  if (reactMode) return module;
  const handlers = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'middleware', 'proxy', 'default']);
  const result = {};
  for (const [key, value] of Object.entries(module)) {
    if (!handlers.has(key) || typeof value !== 'function') { result[key] = value; continue; }
    result[key] = async (request, ...args) => {
      const init = { method: request.method, headers: [...request.headers], signal: request.signal, nextConfig: request.nextUrl?._nextConfig };
      if (!['GET', 'HEAD'].includes(request.method) && request.body) { init.body = request.body; init.duplex = 'half'; }
      const response = await value(module.__rustyx_createRequest(request.url, init), ...args);
      if (response == null) return response;
      if (!(response instanceof vm.context.Response)) throw new TypeError('Edge handler must return a Web Response');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders(response.headers) });
    };
  }
  return result;
}
