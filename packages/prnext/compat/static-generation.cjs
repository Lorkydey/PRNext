'use strict';
const {sampleObject} = require('./instant-samples.cjs');
let requestReader;

function context() {
  // Resolve the circular dependency once. Repeated CJS resolution can stat
  // package.json on every cookies()/params access. Retain the reader function,
  // never the result belonging to a particular visitor.
  try { requestReader ||= require('./headers.cjs').currentRequest; return requestReader?.(); } catch { return undefined; }
}

function createStaticState(options = {}, config = {}) {
  return { mode: options.mode || config.dynamic || 'auto', partial: options.partial === true, revalidate: config.revalidate ?? false,
    tags: new Set(), paths: new Set(), dynamicReasons: new Set(), error: null };
}

function forceStaticRender(request) {
  return ['render', 'route'].includes(request?.phase) && (request.cacheConfig?.dynamic === 'force-static' || request.staticState?.mode === 'force-static');
}

function dynamicUsage(reason, request = context()) {
  if (forceStaticRender(request)) return false;
  return staticBailout(reason, request);
}

function staticBailout(reason, request = context()) {
  const state = request?.staticState;
  if (!state) return true;
  if (state.partial && state.mode === 'auto') {
    state.dynamicReasons.add(reason);
    if (request.metadataRendering) {
      // Unknown fallback params alone do not make an otherwise static metadata
      // export request-dependent. They are postponed by framework resolution.
      if (!reason.startsWith('params for a path')) state.metadataDynamic = true;
    } else state.contentDynamic = true;
    throw Object.assign(new Error(`Partial prerendering postponed ${reason}`), {
      code: 'PRNEXT_PPR_DYNAMIC', digest: 'PRNEXT_PPR_DYNAMIC', dynamicReason: reason,
    });
  }
  const error = Object.assign(new Error(`Static rendering used ${reason}`), {
    code: 'PRNEXT_DYNAMIC_SERVER_USAGE', staticMode: state.mode, dynamicReason: reason,
  });
  // A caught bailout must not silently turn private request data into a shared
  // route. The render checks this state even if application code swallows it.
  state.error ||= error;
  throw error;
}

function trackStaticDependency({ tags = [], paths = [], revalidate, externalCache } = {}, request = context()) {
  const state = request?.staticState;
  if (!state) return;
  if (externalCache) state.externalCache = true;
  if (typeof revalidate === 'number' && Number.isFinite(revalidate) && revalidate >= 0) {
    const seconds = Math.floor(revalidate);
    state.revalidate = state.revalidate === false ? seconds : Math.min(state.revalidate, seconds);
  }
  for (const tag of tags) state.tags.add(tag);
  for (const path of paths) state.paths.add(path);
  if (state.tags.size > 128 || state.paths.size > 128 ||
      Buffer.byteLength(JSON.stringify([[...state.tags], [...state.paths]])) > 48 * 1024) {
    state.error ||= new Error('Static route cache dependencies exceed the PRNext metadata limit');
    throw state.error;
  }
}

function staticMetadata(request = context()) {
  const state = request?.staticState;
  if (!state) return undefined;
  if (state.error) throw state.error;
  return { revalidate: state.revalidate, tags: [...state.tags], paths: [...state.paths], ...(state.externalCache ? { externalCache: true } : {}),
    ...(state.partial ? { dynamicReasons: [...state.dynamicReasons], metadataDynamic: !!state.metadataDynamic, contentDynamic: !!state.contentDynamic } : {}) };
}

function staticParams(values, request = context()) {
  if (request?.instantValidation && request.instantSample) return Promise.resolve(sampleObject(request, 'params', values));
  const unknown = request?.partialParams;
  if (!request?.staticState || !unknown?.some(name => Object.hasOwn(values, name) || Object.values(values).some(value => JSON.stringify(value) === JSON.stringify(request.params?.[name])))) return Promise.resolve(values);
  // Do not assimilate this thenable while constructing the tree. React or the
  // component which actually awaits params must encounter the dynamic access,
  // inside that component's nearest Suspense boundary.
  return { then(resolve, reject) {
    try { dynamicUsage('params for a path not supplied by generateStaticParams', request); resolve(values); }
    catch (error) { if (reject) reject(error); else throw error; }
  } };
}

function staticSearchParams(values, request = context(), clientPage = false) {
  if (request?.instantValidation && request.instantSample) return Promise.resolve(sampleObject(request, 'searchParams', values));
  if (forceStaticRender(request)) return Promise.resolve({});
  if (!request?.staticState || clientPage) return Promise.resolve(values);
  let initializing = true;
  const proxy = new Proxy(values, {
    get(target, property, receiver) {
      // Promise.resolve probes `then` once while constructing the wrapper.
      // Afterwards it is an ordinary query key and reading it is dynamic too.
      if (typeof property === 'string' && !(initializing && property === 'then')) dynamicUsage('searchParams', request);
      return Reflect.get(target, property, receiver);
    },
    has(target, property) { dynamicUsage('searchParams', request); return Reflect.has(target, property); },
    ownKeys(target) { dynamicUsage('searchParams', request); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, property) { dynamicUsage('searchParams', request); return Reflect.getOwnPropertyDescriptor(target, property); },
  });
  const promise = Promise.resolve(proxy);
  initializing = false;
  return promise;
}

module.exports = { createStaticState, forceStaticRender, dynamicUsage, staticBailout, trackStaticDependency, staticMetadata, staticSearchParams, staticParams };
