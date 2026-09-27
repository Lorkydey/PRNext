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
  const Lazy = React.lazy(() => Promise.resolve().then(opts.loader).then(moduleOf));
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
