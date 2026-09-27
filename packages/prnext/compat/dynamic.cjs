'use strict';
const React = require('react');

const DynamicContext = React.createContext(null);
const serverInitializers = new Set();
const readyInitializers = new Map();
const server = typeof window === 'undefined';
let preloading;

function componentOf(module) { return module && module.default ? module.default : module; }
function DefaultLoading({ error, pastDelay }) {
  if (process.env.NODE_ENV !== 'production' && pastDelay && error) {
    return React.createElement('p', null, error.message, React.createElement('br'), error.stack);
  }
  return null;
}

function resource(loader, options) {
  const listeners = new Set();
  let state, promise, delay, timeout, attempt = 0;
  const clear = () => { clearTimeout(delay); clearTimeout(timeout); };
  const update = patch => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const retry = () => {
    clear();
    const version = ++attempt;
    state = { loading: true, loaded: null, error: null, pastDelay: options.delay === 0, timedOut: false };
    promise = Promise.resolve().then(loader);
    if (typeof options.delay === 'number' && options.delay > 0) delay = setTimeout(() => update({ pastDelay: true }), options.delay);
    if (typeof options.timeout === 'number') timeout = setTimeout(() => update({ timedOut: true }), options.timeout);
    void promise.then(loaded => {
      if (version !== attempt) return;
      clear(); update({ loading: false, loaded });
    }, error => {
      if (version !== attempt) return;
      clear(); update({ loading: false, error });
    });
    for (const listener of listeners) listener();
    return promise;
  };
  retry();
  return { retry, promise: () => promise, snapshot: () => state,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); } };
}

function dynamic(input, options) {
  const normalized = input instanceof Promise ? { loader: () => input }
    : typeof input === 'function' ? { loader: input } : input || {};
  const opts = { loading: DefaultLoading, delay: 200, timeout: null, ...normalized, ...options };
  Object.assign(opts, opts.loadableGenerated);
  const Loading = opts.loading || DefaultLoading;
  if (opts.ssr === false && server) {
    return function NoSSR() {
      return React.createElement(Loading, { error: null, isLoading: true, pastDelay: false, timedOut: false });
    };
  }
  const loader = opts.loader || (() => Promise.resolve(() => null));
  if (typeof loader !== 'function') throw new TypeError('dynamic loader must be a function returning a Promise');
  let loaded;
  const init = () => { loaded ||= resource(loader, opts); return loaded.promise(); };
  const ids = opts.ssr === false ? [] : Array.isArray(opts.modules) ? opts.modules : [];
  if (server) serverInitializers.add(init);
  else if (ids.length) readyInitializers.set(init, ids);
  const Component = React.forwardRef(function DynamicComponent(props, ref) {
    init();
    const modules = React.useContext(DynamicContext);
    if (modules) for (const id of ids) modules.add(id);
    const state = React.useSyncExternalStore(loaded.subscribe, loaded.snapshot, loaded.snapshot);
    React.useImperativeHandle(ref, () => ({ retry: loaded.retry }), []);
    if (state.loading || state.error) return React.createElement(Loading, {
      isLoading: state.loading, pastDelay: state.pastDelay, timedOut: state.timedOut,
      error: state.error, retry: loaded.retry,
    });
    return state.loaded ? React.createElement(componentOf(state.loaded), props) : null;
  });
  Component.displayName = 'LoadableComponent';
  return Component;
}

async function preloadAll() {
  if (preloading) return preloading;
  preloading = (async () => {
    while (serverInitializers.size) {
      const pending = [...serverInitializers];
      serverInitializers.clear();
      await Promise.all(pending.map(init => init()));
    }
  })();
  try { await preloading; }
  finally { preloading = undefined; }
}

async function preloadReady(ids = []) {
  const rendered = new Set(ids);
  while (true) {
    const pending = [];
    for (const [init, modules] of readyInitializers) {
      if (!modules.some(id => rendered.has(id))) continue;
      readyInitializers.delete(init);
      pending.push(init());
    }
    if (!pending.length) return;
    // Loading components display failures. Nested imports may register more
    // components whose IDs were also present in the server-rendered document.
    await Promise.allSettled(pending);
  }
}

function DynamicProvider({ modules, children }) {
  return React.createElement(DynamicContext.Provider, { value: modules }, children);
}

module.exports = dynamic;
module.exports.default = dynamic;
module.exports.preloadAll = preloadAll;
module.exports.preloadReady = preloadReady;
module.exports.DynamicProvider = DynamicProvider;
