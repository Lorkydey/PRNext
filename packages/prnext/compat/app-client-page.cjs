'use client';
'use strict';

const React = require('react');
const { AppRouterContext } = require('./app-context.cjs');

function ClientPageRoot({ Component, params, searchParams, ...props }) {
  const router = React.useContext(AppRouterContext);
  const currentSearchParams = React.useMemo(() => {
    if (!router) return searchParams;
    let query;
    function read() {
      if (query) return query;
      // Access belongs to the component that consumes the promise. Reading it
      // in this framework wrapper would suspend every Client Page, even pages
      // which never use searchParams, above their own Suspense boundaries.
      const search = (router.pageSearchParams || router.searchParams).toString();
      query = {};
      for (const [name, value] of new URLSearchParams(search)) {
        if (name === '_rsc') continue;
        const next = Object.hasOwn(query, name) ? [...(Array.isArray(query[name]) ? query[name] : [query[name]]), value] : value;
        Object.defineProperty(query, name, { value: next, enumerable: true, configurable: true, writable: true });
      }
      return query;
    }
    return { get status() { read(); return 'fulfilled'; }, get value() { return read(); },
      then(resolve, reject) { try { resolve(read()); } catch (error) { if (reject) reject(error); else throw error; } } };
  }, [router, searchParams]);
  return React.createElement(Component, { ...props, params, searchParams: currentSearchParams });
}

module.exports.ClientPageRoot = ClientPageRoot;
