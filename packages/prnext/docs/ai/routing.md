# Routing and component boundaries

[AI documentation index](../../AI.md)

## Follow the application's router

PRNext supports Next-style App and Pages conventions. Preserve the router the
project already uses; installing PRNext does not require rewriting every page.
Do not create both routers' implementations for the same URL.

The App Router uses `app/` or `src/app/`, with convention files such as
`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx` and
`route.ts`. A root layout returns `<html>` and `<body>`. App pages/layouts are
Server Components unless a client boundary is declared. A route group such as
`(marketing)` organizes files without adding a URL segment.

The Pages Router uses `pages/` or `src/pages/`, including `index.tsx`, dynamic
segments and `pages/api/`. Existing `getServerSideProps`, `getStaticProps` and
`getStaticPaths` follow the Pages build/runtime pipeline. These hooks do not
belong in an App Router page. Check a specific advanced routing feature against
the installed implementation rather than assuming complete Next.js parity.

App styles follow the page and its layout scopes instead of loading every
page's stylesheet globally. Shared layout sheets are reused, and navigation
loads the next page's sheets before committing its content. Keep shared global
rules in the common layout and use CSS Modules for component-specific selectors.
Do not rely on a sibling page's CSS being present. Loading/error/default and
parallel-route branches can share a route's style plan; test their cascade as
well as ordinary forward and back navigation in a production build.

## Dynamic segments

`app/products/[slug]/page.tsx` matches `/products/example`. App `params` and
`searchParams` are asynchronous; await them. This complete page needs no database
or network request:

### `app/products/[slug]/page.tsx`

```tsx
export default async function Product({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ ref?: string | string[] }>;
}) {
  const { slug } = await params;
  const { ref } = await searchParams;
  return <main>
    <h1>{slug}</h1>
    <p>Reference: {Array.isArray(ref) ? ref.join(', ') : ref || 'none'}</p>
  </main>;
}
```

`[...slug]` is a required catch-all; `[[...slug]]` is optional. Catch-all values
are arrays of path segments. Use `generateStaticParams()` only for values that
can safely be produced at build time. Build-time prerendering can execute page
code, so avoid mutations and unavailable request-dependent services there.

## Isolate client interaction

Keep a small client component for state and browser APIs.

### `app/counter.tsx`

```tsx
'use client';

import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(value => value + 1)}>
    Count: {count}
  </button>;
}
```

Import this component from a server page to render it. Do not turn the entire
layout into a Client Component to fix one hook error. A client boundary includes
its imported code: never import database clients, filesystem code or credentials
through it. Pass appropriate serializable values across the boundary. A Server
Action is an explicit supported server reference, not an ordinary callback prop.

Client Components can participate in server rendering. Read `window`,
`localStorage` and viewport-dependent state in a browser lifecycle such as
`useEffect`, not unconditionally during render. Server and first browser render
must agree. Use `.ts` or `.tsx` for `'use client'` and `'use server'` boundaries;
PRNext rejects those directives in `.mts`/`.cts` instead of silently misbundling.

## Navigation and typed routes

Existing application imports such as `next/link`, `next/navigation`,
`next/headers` and `next/server` are adapted by the PRNext compiler for supported
APIs. Scoped equivalents use `@thomas.f/prnext/link`, `/navigation`, `/headers`
and `/server`. Do not globally replace working imports during a migration, and
do not assume compiler aliases apply to an arbitrary external Node script.

Use `Link` for in-app links and App `useRouter` from `next/navigation` inside a
Client Component. Pages `useRouter` comes from `next/router`; they are different
contracts. Server code can call `redirect()` or `notFound()` from
`next/navigation`; let their control-flow exceptions reach the framework.

Production link prefetching prioritizes keyboard focus, hover and touch over
links entering the viewport. Both routers bound speculative work; an actual
navigation takes priority. Data saver, offline/2G connections and hidden tabs
disable speculation, while slower connections restrict it to intent. Browsers
without connection information retain bounded prefetching. `prefetch={false}`
disables Link speculation, including hover and focus. None of these policies
blocks a real click or changes authorization and private-data checks. App Link
automatic prefetching retains its existing partial-rendering requirement.

### Connection loss during App navigation

App navigation retries transport failures of its GET request within a 30-second
budget and at most three attempts. While disconnected, the current page and its
mounted state remain visible. A newer navigation cancels the older attempt.
Reconnection issues a fresh request with the current cookies; it does not serve
a saved private response. Application errors and deployment mismatches retain
their existing handling. Speculative prefetches are not queued offline.

For an optional application-owned connection indicator:

```tsx
'use client';
import { useOffline } from '@thomas.f/prnext/offline';

export default function ConnectionStatus() {
  const offline = useOffline();
  return offline ? <p role="status">Waiting for a connection…</p> : null;
}
```

The hook reports browser offline status and pending navigation recovery, not a
guarantee that a server is reachable. Exhausted network recovery preserves the
page and dispatches `prnext:navigation-error` on `window`, with `detail.message`
for an application-owned retry notice. This recovery applies to App navigation;
it does not add offline Pages routing, a service worker or persistent storage.

Server Actions and other POSTs are **never automatically replayed**. If a mutation
loses its response, it may already have run: keep the user's input and verify its
result before offering an explicit retry. A full reload still loses ordinary
in-memory state; persist drafts deliberately if they must survive reloads.

With `typedRoutes: true`, `prnext typegen` writes a discovered route registry.
For the dynamic page above, this materializes an encoded URL:

### `lib/product-url.ts`

```ts
import { route } from '@thomas.f/prnext';

export const productUrl = route('/products/[slug]', { slug: 'blue mug' });
// /products/blue%20mug
```

Pass catch-all parameters as arrays. The helper rejects missing/unknown
parameters, separators and dot segments. Add query strings through
`URLSearchParams`; do not embed query or fragment syntax in the route pattern.
Generated route checking is PRNext's registry, not the Next.js language-service
plugin.

## Retained App pages

App layout branches retain inactive UI through React Activity. Effects stop
while hidden, and returning to an authorized destination restores its mounted
form state. The shared default budget is four inactive branches for two minutes,
not four at every nesting level. It is an entry/time limit, not a byte-level RAM
guarantee. It applies within a mounted layout; a new root layout loads a document.

```js
export default {
  navigationCache: { maxEntries: 3, ttlMs: 60000, authCookies: ['session'] },
};
```

Use `navigationCache: false` to disable retention. Server Actions, `router.refresh()`
and observed cookie/authorization changes discard inactive branches while keeping
the current page's client state. Back/forward navigation requests fresh Flight
before revealing a retained destination. Cache hits do not bypass authorization.
After a custom authentication request outside Server Actions, call
`router.refresh()`. A browser integration may also dispatch
`window.dispatchEvent(new Event('prnext:invalidate-navigation'))` to refresh and
clear retained/prefetched state. This is in-memory UI retention, not offline
storage or mutation replay.

By default, cookie changes invalidate inactive branches while ordinary refresh
keeps the active component state. Set `authCookies` to the application's actual
session cookie names to also reset active branches when those credentials change.
Unrelated preference cookies then do not affect retention. Authorization headers
remain part of the identity. Identity is checked in each branch's authorized
request context, including restored parallel slots. In development, the private
identity key remains stable across Fast Refresh; build-time action-key rotation
does not discard the active editor state.

## Route Handlers

An App Route Handler exports HTTP methods and returns a Web `Response` or
`NextResponse`.

### `app/api/health/route.ts`

```ts
export function GET() {
  return Response.json({ ok: true });
}
```

Read a body with `await request.json()` or `await request.formData()` in a
handler that accepts `request: Request`. Validate its shape and authorize access
before writing data. An App Route Handler is not a Pages `(req, res)` API handler.
The example uses the default Node runtime; do not opt into Edge without checking
all dependencies and the installed Edge restrictions.
