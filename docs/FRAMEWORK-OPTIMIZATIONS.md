# Framework optimizations under development

These changes target the next release. The published version remains
0.1.22-alpha; use the qualified branch or its prepared archives to try these APIs.

Production App Router builds put client entry references in their Flight payload.
The common bootstrap no longer lists every route's import. New navigation loads
the referenced entry from the configured build asset directory, sharing the same
React and framework chunks. Development keeps its updateable import table.
Deployment checks, CSS selection and normal unsupported-component fallback remain
in force. This primarily targets large applications' browser startup work.

Navigation hooks subscribe separately to pathname, search parameters, route
parameters and the controller. Memoized consumers of unchanged values can skip
query-only updates. Page remounts and ordinary parent renders can still render
components; this does not memoize application state or deep-compare Flight trees.

Worker manifest registration and parsed partial artifacts use bounded SIEVE caches.
Hits mark an entry without removing and reinserting its Map key. Eviction gives
observed entries another chance; the count and byte limits still apply. Parsed
artifacts are reused only after comparing the current authoritative cache bytes.
This trades a small metadata object per entry for cheaper hot hits; it is not an
automatic RAM reduction, and churn can cost more than LRU.

## Reuse SSR data with TanStack Query

Install both optional peers in the application (tested with 5.107.1):

```sh
npm install @tanstack/react-query@5.107.1 @tanstack/query-core@5.107.1
```

In a Node App Server Component, prepare only data safe for the current visitor:

```tsx
import { getQueryClient, dehydrateQuery } from '@thomas.f/prnext/query/server'
import { QueryProvider } from '@thomas.f/prnext/query'
import { Products } from './Products'

export default async function Page() {
  const account = await getAuthenticatedAccount()
  const client = getQueryClient()
  await client.prefetchQuery({
    queryKey: ['products', account.id],
    queryFn: () => loadProducts(account.id),
  })
  return (
    <QueryProvider state={dehydrateQuery(client)} scopeKey={account.id}>
      <Products accountId={account.id} />
    </QueryProvider>
  )
}
```

```tsx
'use client'
import { useQuery } from '@tanstack/react-query'

export function Products({ accountId }: { accountId: string }) {
  const { data } = useQuery({
    queryKey: ['products', accountId],
    queryFn: ({ signal }) => fetch('/api/products', { signal }).then(r => r.json()),
  })
  return <ul>{data?.map(product => <li key={product.id}>{product.name}</li>)}</ul>
}
```

`getQueryClient(options?)` returns one client for the current PRNext request.
Configure it on the first call; concurrent identical query keys deduplicate.
Server defaults are `staleTime: 60_000`, `gcTime: Infinity`, `retry: false`.
The infinite server GC duration avoids per-query retention timers; clients are
request-owned, never process-global. Request clients and dehydration cannot be
called inside a shared cache scope: cache the underlying data separately instead.

`dehydrateQuery(client?, options?)` reuses the same unchanged standard snapshot.
Multiple Flight boundaries can share that object graph. There is no extra JSON
script or second stringification. Custom dehydration options or default policies
are evaluated on each call. Only successful queries are included by default.
Pending-query transfer requires an explicit TanStack policy and is not a Pages
JSON-props feature. Every dehydrated value is public to that request's browser.

`QueryProvider` owns a browser client when no `client` prop or parent provider
exists. Its defaults are `staleTime: 60_000`, `gcTime: 60_000`; `options` customize
creation. Fresh server data therefore does not immediately refetch. An older
snapshot, explicit invalidation or a query's own `staleTime: 0` can refetch normally.
It retains its client across child Suspense retries and hidden React Activity.
`QueryHydrationBoundary` adds state to an existing provider without making a client.

Use an account-specific `scopeKey` for an owned provider when authentication changes.
It replaces and clears the old owned cache. Configure `navigationCache.authCookies`
with actual session cookie names to reset retained private pages too. A supplied
or inherited QueryClient stays application-owned: the application must clear or
replace it on account changes. Query keys should include all relevant identities.

The adapters currently require the Node runtime; an Edge import fails at build.
Pages can pass a completed snapshot in `getServerSideProps` and use the provider in
`_app`. Put private Pages data in request-owned clients and keep its JSON-serializable
props contract. Query remains optional for applications that do not import it.

## Defer hydration of an explicit heavy widget

This API is experimental and opt-in. Create the wrapper in a Client Component:

```tsx
'use client'
import { deferHydration } from '@thomas.f/prnext/hydration'

const Chart = deferHydration(() => import('./Chart'), {
  when: 'visible',
  rootMargin: '400px',
})

export default function Report({ points }) {
  return <Chart points={points} />
}
```

The server still renders the widget's complete HTML. Initial browser hydration
holds its Suspense boundary and dynamic code import until it becomes visible,
the browser is idle (`when: 'idle'`) or an interaction starts (`'interaction'`).
Focus and pointer intent activate early. A pending primary click or form submit
is replayed once when React has attached the handlers. Native focus and existing
input values remain on the adopted DOM. New props activate the widget and discard
queued actions from old props. Navigation, actions and page hiding cancel queued
activation. Client navigation into a new widget renders it normally.

Optional `prefetch: 'visible' | 'idle'` warms code without opening the boundary.
The default is `false`. `Chart.preload()` explicitly loads the code as well.
`idleTimeout` defaults to 2,000 ms; missing visibility/idle APIs fall back to idle
or a timer. `as` selects the wrapper element (default `div`); choose a valid
container for the surrounding HTML. `fallback` is the ordinary Suspense fallback.

The child uses a real dynamic import: importing the same widget eagerly elsewhere
can remove the network saving. Do not defer essential navigation, authentication,
checkout or controls requiring immediate synchronous execution. Replayed events
are synthetic; widgets needing trusted events or transient browser activation
(for example a popup or clipboard permission) must hydrate eagerly. Server
Components that already ship no client component code do not benefit from this.

React remains the owner of the root and boundary. The adapter does not copy HTML,
replace `innerHTML` or create extra React roots. Its contract follows
[React hydration](https://react.dev/reference/react-dom/client/hydrateRoot) and the
Query integration follows [TanStack SSR guidance](https://tanstack.com/query/latest/docs/framework/react/guides/ssr).

## Measure on the target application

Run `node --expose-gc tests/performance/framework-optimizations.mjs BASELINE_CHECKOUT result.json`
for local route-scaling, cache hot/churn and query-only rendering diagnostics.
The two checkouts need installed locked dependencies and a built native executable.
It varies unrelated routes (10/100/1,000), alternates three browser pairs and
records bootstrap/Flight gzip bytes, Chromium script CPU and post-GC isolate heap.
The active page has 1,024 memoized hook consumers. Cache samples retain capacity 32
and report misses as well as time. Shared-PC observations establish no universal
speedup, production RSS reduction or VPS capacity guarantee.

Local diagnostic on Windows x64, Node 24.22.1, against source `080a33d2`
(three alternating Chromium pairs, same active page):

| Unrelated routes | Previous bootstrap gzip | New bootstrap gzip |
| --- | ---: | ---: |
| 10 | 83,094 B | 83,135 B |
| 100 | 85,537 B | 83,135 B |
| 1,000 | 105,722 B | 83,133 B |

At 1,000 routes, all initially requested scripts totalled 123,886 → 101,789
gzip bytes (−17.8%). Post-GC page-isolate heap was 2,974,792 → 2,694,744 B
(−9.4%). Startup script CPU was approximately 39.7 → 39.4 ms: this run does
not establish a significant startup CPU gain. The small application paid
533 additional gzip bytes across all initial scripts.

Query-only updates rendered 256 of 1,024 observed components instead of all
1,024 (−75%). Script CPU including navigation was approximately 11–12 ms
before and 10.7–11 ms after; fewer component renders are not a corresponding
end-to-end speed multiplier. The fixed Flight response grew by about 40 gzip
bytes because it now carries its own client references.

The capacity-32 cache microbenchmark was 2.05× faster for hot hits and 1.65×
faster for the mixed trace, with essentially equal hit ratios. The scan trace
was **0.77×** as fast (slower); this is why SIEVE is scoped to two bounded
runtime caches and is not advertised as a universal cache or RAM improvement.
Full cache traces and browser samples remain in the local qualification report.
