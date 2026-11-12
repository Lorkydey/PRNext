'use client';
'use strict';
const React = require('react');
const { QueryClient, QueryClientContext, QueryClientProvider, HydrationBoundary } = require('@tanstack/react-query');

function QueryHydrationBoundary({ state, children }) {
  return React.createElement(HydrationBoundary, { state }, children);
}

function QueryProvider({ children, state, client, scopeKey, options, fallback = null }) {
  const parent = React.useContext(QueryClientContext);
  // An existing application QueryClient remains authoritative. The optional
  // scope key replaces an owned cache when the authenticated account changes.
  const resource = React.useMemo(() => ({ owned: !client && !parent, client: client || parent || new QueryClient({ ...options,
    defaultOptions: { ...options?.defaultOptions, queries: {
      staleTime: 60_000, gcTime: typeof window === 'undefined' ? Infinity : 60_000,
      ...options?.defaultOptions?.queries,
    } },
  }) }), [client, parent, scopeKey]);
  const previous = React.useRef(resource);
  React.useEffect(() => {
    const old = previous.current;
    previous.current = resource;
    // Activity disconnects effects without destroying the retained provider.
    // Preserve its data; clear only an owned cache replaced by an account scope.
    if (old !== resource && old.owned) old.client.clear();
  }, [resource]);
  const hydrated = state === undefined ? children : React.createElement(QueryHydrationBoundary, { state }, children);
  // Keep the provider above suspended queries so initial retries retain the
  // same QueryClient instead of launching a second fetch with a fresh cache.
  const content = React.createElement(React.Suspense, { fallback }, hydrated);
  return resource.client === parent ? content : React.createElement(QueryClientProvider, { client: resource.client }, content);
}

module.exports = { QueryProvider, QueryHydrationBoundary };
