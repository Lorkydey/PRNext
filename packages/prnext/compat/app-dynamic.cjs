'use strict';
const React = require('react');
const { DynamicBailout } = require('./dynamic-bailout.cjs');

function moduleOf(value) {
  return { default: value && 'default' in Object(value) ? value.default : value };
}

function ClientOnly({ children }) {
  if (typeof window === 'undefined') throw new DynamicBailout();
  return children;
}

function dynamic(input, options) {
  // App Router deliberately accepts the function form here. Pages' direct
  // Promise and first-argument options forms have a separate adapter.
  const opts = { loader: () => Promise.resolve(() => null), loading: null, ssr: true,
    ...(typeof input === 'function' ? { loader: input } : {}), ...options };
  if (!opts.ssr && typeof React.useEffect !== 'function') {
    throw new Error('ssr: false is not supported with next/dynamic in Server Components. Move it into a Client Component.');
  }
  let Lazy;
  if(process.env.NODE_ENV==='development'&&typeof window!=='undefined'&&typeof opts.__prnextDevIdentity==='string'){
    const registry=globalThis.__PRNEXT_DEV_DYNAMIC__||=new Map();
    let entry=registry.get(opts.__prnextDevIdentity);
    if(!entry||entry.failed){
      entry={loader:opts.loader};
      entry.lazy=React.lazy(()=>Promise.resolve().then(()=>entry.loader()).then(moduleOf,error=>{entry.failed=true;throw error;}));
      if(registry.size>=2048)registry.delete(registry.keys().next().value);
      registry.set(opts.__prnextDevIdentity,entry);
    }else entry.loader=opts.loader;
    Lazy=entry.lazy;
  }else Lazy=React.lazy(() => Promise.resolve().then(opts.loader).then(moduleOf));
  function DynamicComponent(props) {
    const fallback = opts.loading ? React.createElement(opts.loading, { isLoading: true, pastDelay: true, error: null }) : null;
    const child = React.createElement(Lazy, props);
    if (!opts.ssr) return React.createElement(React.Suspense, { fallback }, React.createElement(ClientOnly, null, child));
    return opts.loading ? React.createElement(React.Suspense, { fallback }, child) : child;
  }
  DynamicComponent.displayName = 'LoadableComponent';
  return DynamicComponent;
}

module.exports = dynamic;
module.exports.default = dynamic;
