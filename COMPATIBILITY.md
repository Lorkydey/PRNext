# PRNext compatibility scope

PRNext is an alpha React runtime with its own build pipeline, a Rust HTTP server
and Node/V8 rendering workers. Compatibility with Next.js is partial. Passing
preflight is not a guarantee that every feature used by an application works.
This scope describes the current development tree, including the unreleased
changes listed in the changelog. Check the installed package's version before
applying it to an older release; the package also includes
[version-specific AI guides](packages/prnext/AI.md), available through
`prnext docs --ai`.

| Input | Current path | Boundary |
| --- | --- | --- |
| React with `pages/` or `app/` conventions | Default `prnext build` | Supported conventions are implemented by PRNext; Next.js internals are not a public integration interface. |
| App Router SSR, streaming, RSC and Server Actions | Default React adapter | Matching supported React/React DOM/RSC versions are required. Validate application behavior before migration. |
| TypeScript | Default React adapter; `prnext typegen` / `prnext typecheck` | Application-installed TypeScript 7 uses its native CLI; TypeScript 5/6 retain their compiler API path. Background diagnostics and typed routes support both paths. Production build checks remain opt-in through `typescript`. The Next.js editor plugin is not implemented. |
| Connection recovery | App navigation GETs | Bounded retries preserve the mounted page and cancel superseded navigation. Actions/POSTs are never replayed. The optional `useOffline` hook exposes connection/recovery state; this does not add persistent offline storage or Pages navigation recovery. |
| Shared Redis cache | Optional `@thomas.f/prnext/cache/redis` handler | Cross-process Cache Components fills and atomic tag invalidation; requires a separately installed node-redis client. Native HTML/ISR, fetch and `unstable_cache` backends remain separate. See the [cache guide](packages/prnext/docs/ai/data.md#shared-redis-cache-components). |
| Typed routes | Opt-in `typedRoutes: true` | PRNext generates its own route registry for supported Link/router calls and the `route()` helper. It does not consume Next.js-generated route declarations. |
| Static HTML, CSS, JavaScript and public assets | `--adapter static --from dist` | Import an already-built public directory with a root `index.html`. No React installation is needed in that project. |
| Vite client applications, including React or Vue | Static adapter, optionally `--spa` | The original framework performs compilation; PRNext serves the browser output. This does not add SSR support for that framework. |
| Nuxt, SvelteKit, Astro or TanStack Start server output | No generic server adapter yet | Server entrypoints need a dedicated integration. Do not import server bundles as public files. Static exports can be imported if they meet the static contract. |
| React Compiler | Opt-in `reactCompiler: true` | Bundled official compiler for project-owned browser components and App Client Component server rendering. Pages server rendering, APIs/data loaders, Server Components, Server Actions, framework modules and npm packages stay outside the transform. Disabled by default. See the [compiler guide](packages/prnext/docs/ai/compatibility.md#react-compiler). |
| HTTP/1 WebSockets | Tunnels through external HTTP(S) rewrites, `pstart` and multi-app `host` | The upstream must implement WebSockets. App/Pages handlers do not gain a WebSocket server API. Other protocol upgrades are rejected; generation drains can close remaining tunnels. |

Recommended validation for a React application:

```sh
prnext check --json
prnext typecheck
prnext build
prnext output --json
prnext start
```

The explicit type check requires the application's TypeScript installation and
tsconfig; it fails semantic errors even when a build is configured to ignore
them. React server/client directives in `.mts`/`.cts` files are rejected; use
`.ts`/`.tsx` for those framework boundaries. Ordinary TypeScript helpers remain
supported.

Test its actual pages, APIs, authentication, client navigation, cache behavior and
failure paths. `prnext migrate --check --against URL --candidate URL` can compare
selected GET responses, but cannot establish complete application equivalence.

New adapters have a separate, versioned [output contract](packages/prnext/build/ADAPTERS.md).
The existing worker lifecycle contract continues to protect cancellation,
post-response work and graceful shutdown. Adapter metadata cannot bypass it.
