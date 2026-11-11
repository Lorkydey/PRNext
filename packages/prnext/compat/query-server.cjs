'use strict';
const { QueryClient, dehydrate } = require('@tanstack/query-core');
const { currentRequest } = require('./headers.cjs');

const REQUEST_CLIENT = Symbol('PRNext request QueryClient');
const snapshots = new WeakMap();

function getQueryClient(options) {
  if (require('./data-cache.cjs').inCacheScope()) throw new Error('Prepare Query state outside a cache scope; cache the underlying data instead');
  const request = currentRequest();
  if (!request[REQUEST_CLIENT]) request[REQUEST_CLIENT] = new QueryClient({ ...options,
    defaultOptions: { ...options?.defaultOptions, queries: {
      staleTime: 60_000, gcTime: Infinity, retry: false, ...options?.defaultOptions?.queries,
    } },
  });
  return request[REQUEST_CLIENT];
}

function dehydrateQuery(client = getQueryClient(), options) {
  if (require('./data-cache.cjs').inCacheScope()) throw new Error('Prepare Query state outside a cache scope; cache the underlying data instead');
  // Custom filters/serializers may depend on mutable application state. Let
  // TanStack evaluate them on every call; only the standard snapshot is memoized.
  if (options !== undefined || client.getDefaultOptions().dehydrate) return dehydrate(client, options);
  let entry = snapshots.get(client);
  if (!entry) {
    entry = { value: undefined };
    const changed = event => {
      if (event.type === 'added' || event.type === 'removed' || event.type === 'updated') entry.value = undefined;
    };
    client.getQueryCache().subscribe(changed);
    client.getMutationCache().subscribe(changed);
    snapshots.set(client, entry);
  }
  // Reusing the same snapshot also lets React Flight share one object graph
  // across boundaries. Never stringify it or embed a second JSON script.
  return entry.value ||= dehydrate(client);
}

module.exports = { getQueryClient, dehydrateQuery };
