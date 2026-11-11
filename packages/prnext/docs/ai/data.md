# Request data, actions and caching

[AI documentation index](../../AI.md)

## Request context

Use server request APIs only while handling a PRNext request. Await `headers()`
and `cookies()` from `next/headers`. Headers are read-only; cookie writes belong
in a Server Action or Route Handler before response headers commit. Do not read
the current request at module initialization or stash request data in a
process-global variable.

The following complete example stores a non-sensitive display preference. It is
not an authentication or session implementation.

### `app/preferences/actions.ts`

```ts
'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

export async function saveTheme(form: FormData) {
  const theme = form.get('theme');
  if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid theme');
  const store = await cookies();
  store.set('theme', theme, { httpOnly: true, sameSite: 'lax', path: '/' });
  revalidatePath('/preferences');
}
```

### `app/preferences/page.tsx`

```tsx
import { cookies } from 'next/headers';
import { saveTheme } from './actions';

export default async function Preferences() {
  const store = await cookies();
  const theme = store.get('theme')?.value === 'dark' ? 'dark' : 'light';
  return <main>
    <h1>Preferences</h1>
    <p>Current theme: {theme}</p>
    <form action={saveTheme}>
      <select name="theme" defaultValue={theme} aria-label="Theme">
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <button type="submit">Save</button>
    </form>
  </main>;
}
```

Server Actions accept untrusted input even when invoked through a form you
rendered. Check authentication, authorization and input on every protected
mutation. For real session cookies, use the application's session library and
production HTTPS policy, including appropriate secure cookie settings.

## Fetch deliberately

Choose freshness explicitly. Request-specific or sensitive reads normally need
`fetch(url, { cache: 'no-store' })`. Shared public data can opt into
`cache: 'force-cache'` and `next: { revalidate: seconds, tags: [...] }`. The
`next` extension belongs to PRNext's server fetch integration, not browser fetch.
Check `response.ok` and validate the returned data before using it.

Under the default route configuration, an ordinary fetch or `next.tags` alone
does not request persistent caching. Route configuration can change defaults;
inspect it before diagnosing a cache. Avoid conflicting `cache` and `revalidate`
options. A successful fetch cache hit is different from cached HTML, a browser
router cache hit or a compiler cache hit.

`unstable_cache` caches JSON-serializable function results. A runnable public-data
example:

### `lib/catalog.ts`

```ts
import { unstable_cache } from 'next/cache';

export const readCatalog = unstable_cache(
  async () => [{ id: 'demo', name: 'Demo product' }],
  ['public-catalog-v1'],
  { tags: ['catalog'], revalidate: 60 },
);
```

The static array stands in for a real server-side data read. Do not perform
mutations in the cached callback. Read cookies/headers outside `unstable_cache`
and pass required values as arguments. Include tenant/user identity in any
appropriate cache key and authorize before access; never treat a shared cache as
a session store. Avoid caching private data unless its isolation is deliberate
and tested. Changes in closed-over values need explicit key parts or arguments.

## Invalidate in the mutation

`revalidatePath('/preferences')` invalidates a concrete path. A dynamic pattern
requires its kind, such as `revalidatePath('/products/[slug]', 'page')`.
`revalidateTag('catalog', 'max')` marks tagged data stale for revalidation;
`updateTag('catalog')` expires it for read-your-own-writes in a Server Action.
`updateTag` is action-only; path/tag revalidation also supports Route Handlers.
Perform the underlying successful write before invalidating its cache.

Invalidation APIs are rejected during rendering, inside a cached callback and
after response headers have been sent. They do not delete unrelated build caches
or restart the server. Custom cache handlers can delegate these semantics; do
not infer their hit rate from PRNext's native-cache diagnostics.

The installed implementation also has `cacheComponents`, `'use cache'`,
`cacheLife` and `cacheTag` support. These are additional cache contracts; do not
enable them to silence a request-context error or assume their complete upstream
behavior. Keep a working `unstable_cache` or fetch solution unless the project
needs a different model.

## Navigation stages

Enable `cacheComponents: true` and `partialPrefetching: true` to separate runtime
App Shell work from per-link prefetch work and actual navigation work:

```jsx
import { Suspense } from 'react';
import { navigation, prefetch } from 'next/cache';

async function Recommendations() {
  await prefetch();
  return <div>{await getCachedRecommendations()}</div>;
}

async function ExpensiveReport() {
  await navigation();
  return <div>{await getCachedReport()}</div>;
}

export default function Page() {
  return <>
    <Suspense fallback={<p>Loading recommendations</p>}><Recommendations /></Suspense>
    <Suspense fallback={<p>Loading report</p>}><ExpensiveReport /></Suspense>
  </>;
}
```

Define and authorize the application-specific data functions above. Call gates
before invoking a cached function, never inside its cached scope. Both gates
require Cache Components. Static prerenders continue through them, so static
output can already contain the result. Without partial prefetching, `prefetch()`
has no effect and an explicit `Link prefetch={true}` requests the full route.

A default Link requests the shell. `prefetch={true}` permits per-link work;
content below `navigation()` waits for the navigation. Runtime previews are
private, size-bounded and tied to the request's authorization identity. They do
not authorize a subsequent navigation.
Uncached runtime fetches and `connection()` remain deferred during speculative
rendering. Put reusable I/O in a cached function to make it eligible for an
earlier stage; a gate does not itself cache data.

Pages and layouts may export `ensureStatic = 'shell'`, `'prefetch'` or
`'navigation'`. Earlier stages are included in stricter levels. A descendant
cannot weaken a parent; `false` conflicts with a static requirement elsewhere
in the route. `'auto'` adds no requirement. Client Component exports are rejected.
`'shell'` and `'prefetch'` request static output for those stages without adding
a separate full-route build check. `'navigation'` validates complete static
server output during build and development, including request APIs beneath
Suspense, metadata and complete dynamic parameter sets. It requires nonempty,
complete `generateStaticParams()` results for dynamic routes. All levels require
Cache Components; shell/prefetch levels need partial prefetching to select stages.

## Shared Redis Cache Components

The optional first-party Redis handler shares `'use cache'` results across Node
processes. Install `@redis/client@^6.3.0` only in applications using it; a normal PRNext
installation and generated project do not require Redis.

### `redis-handler.mjs`

```js
import { createRedisCache } from '@thomas.f/prnext/cache/redis';

export default createRedisCache({
  namespace: 'my-app-production-v1',
  urlEnv: 'REDIS_URL',
});
```

### `prnext.config.mjs`

```js
export default {
  cacheComponents: true,
  cacheHandlers: { remote: './redis-handler.mjs' },
};
```

### `app/catalog/read.ts`

```ts
import { cacheLife, cacheTag } from 'next/cache';

export async function readCatalog() {
  'use cache: remote';
  cacheLife('hours');
  cacheTag('catalog');
  return [{ id: 'demo', name: 'Demo product' }];
}
```

Set the Redis URL in the server's runtime environment. It is not embedded in the
handler bundle. Replicas sharing results need the same namespace and compatible
build output. Use separate namespaces for unrelated apps, environments and
incompatible deployments. This factory handles Cache Components. The separate
incremental factory below handles native HTML/ISR, fetch and `unstable_cache`.

Cache fills use a bounded cross-process lease. Atomic tag generations prevent a
fill invalidated while running, or an expired lease owner, from publishing old
data. Soft tag invalidation retains stale-while-revalidate behavior; immediate
expiration prevents another replica from reading the old entry. Losing the tag
registry invalidates existing entries rather than resurrecting them.

Values are limited to 2 MiB, metadata to 64 KiB and each entry to 256 tags.
The tag registry is bounded; excess cardinality conservatively invalidates the
namespace. Default retention is at most seven days. Defaults use a 30-second
lease, a 2.5-second fill wait and one-second command timeout. Reads can fall back
to fresh computation on cache failure; invalidation failures remain errors.
Cached callbacks must be safe to execute more than once after timeout or outage:
leases reduce duplicate work, not provide exactly-once business operations.

An already connected node-redis client can be supplied as `client`; its lifecycle
remains the application's responsibility. Otherwise the handler connects lazily
and owns its client. Use Redis appropriate for the application's availability,
access controls and data sensitivity; a shared cache is not an authorization
boundary or a durable database.

## Shared Redis pages and request data

Configure `cacheHandler` with the constructor returned by the incremental factory:

```js
// incremental-redis.mjs
import { createRedisIncrementalCache } from '@thomas.f/prnext/cache/redis';
export default createRedisIncrementalCache({ namespace: 'my-app-production' });
```

```js
// prnext.config.mjs
export default {
  cacheHandler: './incremental-redis.mjs',
  cacheMaxMemorySize: 0,
};
```

Set `REDIS_URL` at runtime and install the optional `@redis/client@^6.3.0` client.
The same configuration works for App and Pages HTML/ISR, static Route Handlers,
cacheable `fetch` and `unstable_cache`. It does not cache private dynamic pages.
Replicas must use compatible builds and share an application-specific namespace.
Cache Components still select their own `cacheHandlers`; both factories may use
the same namespace to share tag invalidations.

The runtime acquires a shared generation lease before rendering, checks for a
winner's result after waiting and carries that lease through publication. An
invalidation or expired lease rejects late writes atomically. Runtime reads and
publication remain bounded; unavailable Redis can prevent a page regeneration
from succeeding. A shared cache is not a durable database or an exactly-once
execution mechanism. Keep producers safe to retry.

Incremental entries preserve Buffer and Map values, have a 16 MiB serialized
limit and use V8-major-specific keys. The default generation lease is 60 seconds;
`leaseMs` can be configured up to 120 seconds. Configure it for the expected
generation duration. The default maximum storage age remains seven days.
New cacheHandler builds include a native generation-lease capability check;
use the matching PRNext native binary and rebuild existing output.

## Background work and durable data

`after()` from `next/server` is supported in Node Server Components (including
layouts and metadata), Route Handlers and Server Actions. It runs tracked
callbacks after the response completes or disconnects; static renders execute
them during the build. Edge lifecycles remain unsupported. In a Server Component,
read request data before registering the callback and capture the needed values:
`headers()`, `cookies()` and `draftMode()` inside that callback are rejected.
Route Handler and Action callbacks can read their retained request context.
Cookie writes and path/tag invalidation are rejected after the response;
invalidate before returning from the mutation.

Tracked callbacks are bounded by the route's `maxDuration` and shutdown
deadlines; forced termination can interrupt them. Use an external durable queue
for work that must survive a restart. Module globals, local runtime caches and
temporary files are not substitutes for a database or durable job store.

## Optional TanStack Query SSR

The Query adapters belong to the post-0.1.22 source changes. Published
0.1.22-alpha does not expose these exports; use a qualified candidate or a later
release that includes them. Query is optional: do not add it to a project that
does not need browser query state. Its peer ranges are
`@tanstack/react-query@^5.107.1` and `@tanstack/query-core@^5.107.1`.
The integration is tested with these exact versions:

```sh
npm install '@tanstack/react-query@5.107.1' '@tanstack/query-core@5.107.1'
```

In a Node App Server Component, prepare authorized browser-safe data with
`getQueryClient()` from `@thomas.f/prnext/query/server`. It returns one client for
the logical request, including cloned metadata/page contexts. Configure its
options on the first call. Concurrent identical query keys deduplicate.
Default server query options are `staleTime: 60_000`, `gcTime: Infinity` and
`retry: false`; no process-global client or shared private cache is created.

```tsx
import { getQueryClient, dehydrateQuery } from '@thomas.f/prnext/query/server';
import { QueryProvider } from '@thomas.f/prnext/query';

// Supply the application's auth/data helpers and ProductList component.
export default async function ProductsPage() {
  const accountId = await getAuthenticatedAccountId();
  const client = getQueryClient();
  await client.prefetchQuery({
    queryKey: ['products', accountId],
    queryFn: () => loadAuthorizedProducts(accountId),
  });
  return <QueryProvider state={dehydrateQuery(client)} scopeKey={accountId}>
    <ProductList accountId={accountId} />
  </QueryProvider>;
}
```

Use the application's own authentication/data loader and client `ProductList`.
In that client component, use TanStack's `useQuery` with the same query key and
an authorized browser query function that consumes its cancellation signal.
The owned provider defaults to `staleTime: 60_000` and browser `gcTime: 60_000`,
so fresh SSR data does not immediately refetch. Explicit invalidation, stale data
or a query's own `staleTime: 0` can refetch normally.

`dehydrateQuery(client?, options?)` reuses the unchanged standard snapshot so
Flight can share it across boundaries. Do not add a second JSON script or
stringify the cache again. Custom dehydration policies run on every call; only
successful queries are included by default. Every dehydrated value is visible
to that browser. Do not prepare clients/snapshots inside `'use cache'` or
`unstable_cache`; cache underlying data separately with deliberate isolation.

`QueryHydrationBoundary` from `@thomas.f/prnext/query` adds a snapshot beneath an
existing provider. Nested `QueryProvider` components reuse the parent client;
a supplied `client` prop also remains application-owned. The adapter does not
override that client's freshness policy or clear it on account changes.
Use identity-specific keys and replace/clear application-owned clients when
authentication changes. For an owned provider, change `scopeKey` with the account
and configure actual `navigationCache.authCookies` to reset retained private UI.
React Activity hiding preserves an owned cache; account-scope replacement clears
the replaced owned cache.

These adapters require Node; an Edge import fails during build. Pages can pass a
completed, JSON-serializable snapshot from `getServerSideProps` and use the
provider in `_app`. Arbitrary pending promises are not Pages JSON props.
