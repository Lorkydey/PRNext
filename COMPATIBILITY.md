# PRNext compatibility scope

PRNext is an alpha React runtime with its own build pipeline, a Rust HTTP server
and Node/V8 rendering workers. Compatibility with Next.js is partial. Passing
preflight is not a guarantee that every feature used by an application works.

| Input | Current path | Boundary |
| --- | --- | --- |
| React with `pages/` or `app/` conventions | Default `prnext build` | Supported conventions are implemented by PRNext; Next.js internals are not a public integration interface. |
| App Router SSR, streaming, RSC and Server Actions | Default React adapter | Matching supported React/React DOM/RSC versions are required. Validate application behavior before migration. |
| TypeScript | Default React adapter | Transpilation is available. Production type checking is opt-in through the supported `typescript` configuration. Next-generated route types and its editor plugin are not implemented. |
| Static HTML, CSS, JavaScript and public assets | `--adapter static --from dist` | Import an already-built public directory with a root `index.html`. No React installation is needed in that project. |
| Vite client applications, including React or Vue | Static adapter, optionally `--spa` | The original framework performs compilation; PRNext serves the browser output. This does not add SSR support for that framework. |
| Nuxt, SvelteKit, Astro or TanStack Start server output | No generic server adapter yet | Server entrypoints need a dedicated integration. Do not import server bundles as public files. Static exports can be imported if they meet the static contract. |
| React Compiler, generated typed routes | Not implemented | Enabling unsupported options produces an explicit build error. |
| WebSocket/protocol upgrades | Not implemented by native hosting | HTTP streaming is supported; protocol upgrades return 501. |

Recommended validation for a React application:

```sh
prnext check --json
prnext build
prnext output --json
prnext start
```

Test its actual pages, APIs, authentication, client navigation, cache behavior and
failure paths. `prnext migrate --check --against URL --candidate URL` can compare
selected GET responses, but cannot establish complete application equivalence.

New adapters have a separate, versioned [output contract](packages/prnext/build/ADAPTERS.md).
The existing worker lifecycle contract continues to protect cancellation,
post-response work and graceful shutdown. Adapter metadata cannot bypass it.
