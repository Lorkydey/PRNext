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
