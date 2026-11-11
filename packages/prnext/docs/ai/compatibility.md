# Compatibility and migration

[AI documentation index](../../AI.md)

## Treat compatibility as a checked contract

PRNext adapts many public Next.js conventions; it is not a drop-in implementation
of every Next.js version. Package installation, a recognized import or a green
source audit does not prove an application works. The installed package's
metadata, declarations, diagnostics and executable behavior are the authority
for this release. Do not use an old repository checklist to override them.

Common supported areas include App/Pages routing, React Server Components,
Server Actions, request APIs, navigation, route metadata, supported cache APIs,
CSS Modules and the project's PostCSS pipeline. Scope varies by runtime and
option. Advanced parallel/intercepting routing, custom webpack/loaders, package
transpilation, image/font tooling and caching deserve targeted build and browser
tests. Support for one configuration shape does not imply support for all
upstream plugin behavior.

When moving from 0.1.19-alpha, use the installed
[upgrade checklist](deployment.md#upgrading-from-0119-alpha): rebuild matching
artifacts, configure the public HTTPS origin and proxy trust, verify strict
account transitions and review saved persistent health routes. Storage cleanup
must preserve runtime data and invalidation history. Experimental performance
options remain independent and opt-in.

## Instrumentation and tracing

Use a single `instrumentation.ts`, `.js`, `.mjs` or `.cjs` at the project root
or in `src`. Export an optional async `register()` for runtime initialization
and an optional async `onRequestError(error, request, context)` for reporting.
The `Instrumentation.onRequestError` type is exported from PRNext's root API.
`process.env.NEXT_RUNTIME` distinguishes `nodejs` and `edge`; conditional imports
keep Node SDKs out of an Edge bundle. Registration runs once per server realm,
including the separate RSC realm, before application requests. A production
prerender does not run the runtime startup hook. Request-time ISR and PPR
regeneration initialize their server realm and report failures through the same
hooks. Repeated propagation of an RSC error to the HTML worker does not report
the same error again.

```ts
import type { Instrumentation } from '@thomas.f/prnext'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./observability.node')
  }
}

export const onRequestError: Instrumentation.onRequestError = async (
  error, request, context
) => {
  await reportError(error, request, context)
}
```

`reportError` above is an application function, not a PRNext API. Initialization
has a 30-second budget. Each error hook has a five-second budget; reporting
failure does not replace the application failure. Redirect/not-found control
signals are excluded. Hooks receive request information: the application owns
redaction before sending that information to a third party.

For built-in correlated traces, explicitly set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to an OTLP HTTP collector's complete traces
URL and `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`. Alternatively,
`OTEL_EXPORTER_OTLP_ENDPOINT` supplies a base URL with `/v1/traces` appended.
`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (or general
`OTEL_EXPORTER_OTLP_HEADERS`) and `OTEL_SDK_DISABLED=true` are supported. Keep
exporter credentials in the server environment. This built-in path supports
HTTP JSON, not gRPC or HTTP protobuf; use your own SDK for other protocols.

Native HTTP spans cover static and dynamic responses through body completion
or cancellation. Node, RSC and fetch spans share W3C trace context. Export queues
are bounded and telemetry is best effort; an unavailable collector does not
block a site response. Built-in span attributes exclude bodies, cookie values,
query strings and authorization headers. An application-installed
`@opentelemetry/api` can use the same parent context when its SDK installs a
context manager in `register`. No SDK is installed automatically, and this does
not certify every vendor integration.

## Production bytes and navigation

Production CSS Modules use deterministic compact class and animation names.
Global classes and declared composition exports retain their meaning; development
keeps readable names. Internal JavaScript exports are shortened by the selected
compiler, while public exports and dynamic imports keep their interfaces. Asset
hashes and source maps remain compiler-owned.

App navigation can negotiate binary differential Flight responses. Every request
still runs fresh rendering and access checks. The server retains at most 64
completed bases, 32 MiB in total, with a two-MiB per-base limit and 30-second
expiry. Bases are keyed by deployment and credentials; an unknown, expired or
incompatible base produces ordinary Flight. The browser retains one completed
base, streams reconstructed bytes to React and can retry one failed differential
navigation as a full GET. Server Actions are never replayed through this path.
Per worker, at most eight captures and two encoders run together. Additional
requests use ordinary Flight, keeping transient transport work bounded too.

Configuration uses one `next.config.*` or `prnext.config.*` file and rejects
unknown keys rather than ignoring them. React Compiler is available through an
explicit `reactCompiler` option described below. `typedRoutes: true` is
implemented through PRNext's generated route registry. Do not copy a full
Next.js configuration template into a new application.

The repository's reference tests build and run matching applications against
Next.js 16.4.4, including mounted App navigation, form Actions and cookies,
metadata, Pages locale routing, redirects, APIs and selected webpack loader
contracts. These executable examples cover specific behavior; they do not
certify every Next.js application or plugin. `NextRequest.nextUrl` understands
data-route build IDs and locales, and request-cookie mutations synchronize the
request header. Request cookies have different mutation results from response
cookies; do not use them interchangeably.

A locked real-application fixture additionally exercises Better Auth 1.7.15
(email/password, session cookies and logout), Drizzle ORM 0.45.4 over SQLite
through its proxy driver, next-intl 4.14.9 (server and client translations),
and the MDX 3.1.1 webpack loader against Next.js 16.4.4. It covers authenticated
Server Actions, user-owned rows, cookie/locale isolation, client navigation and
Server Component `after()` callbacks. This is evidence for those workflows,
not a guarantee for every plugin, provider or deployment configuration.

PRNext-specific options such as `prerender` and `htmlOnly` are described in
[Build and deployment](deployment.md). Do not pass them to an upstream Next.js
build when comparing the two implementations.

## TypeScript 7 and earlier compilers

PRNext uses the application's installed TypeScript. TypeScript 7 runs through its
official native `tsc` command for production checks, `prnext typecheck` and live
development diagnostics. Install TypeScript normally, including its platform
optional dependencies. PRNext does not download a compiler during a build.
TypeScript 5 and 6 retain their compiler API integration.

Checks use `--noEmit` and keep incremental compiler state in an owned temporary
directory. Development reports updated errors and clears fixed diagnostics;
new source files and configuration changes restart the native watch generation.
`typedRoutes` also supports native TypeScript and preserves JSONC comments when
adding its generated declaration to the config. Compiler support does not imply
that every application is ready for TypeScript 7's own language/config changes.

## Experimental performance paths

The following switches are independent, opt-in and disabled by default. Keep
them in the application's existing configuration and qualify actual workflows:

```js
export default {
  cacheComponents: true,
  experimental: {
    nativePprShell: true,
    streamingRequestBodies: true,
    parallelBuilds: {maxWorkers: 4, maxMemoryMb: 1024},
  },
};
```

`nativePprShell` sends the certified build shell from Rust before Node starts,
then resumes React. Eligibility is concrete Node App PPR document GETs without
query, cookies, authorization, middleware, rewrites, base paths, router-state,
Flight/prefetch headers or CSP nonces. Generic shells, Edge, external caches and
unsupported requests retain Node rendering. Checked hashes/sizes and a private
continuation field protect the artifact; no HTTP flag enables it. Responses are
private/no-store. The generation must remain zero and the artifact unexpired:
persisted invalidation disables this snapshot across restarts, not PPR itself.
An already admitted response finishes with its original artifact.

`streamingRequestBodies` exposes Node App Route Handler `Request.body` before
upload EOF, with a negotiated capability and one 64 KiB frame per reader credit.
Unsupported workers, Server Actions, Pages APIs and middleware-buffered requests
retain buffering. The total limit is 32 MiB and ingress reservations remain.
Effects can precede rejection of truncated/excessive input: finish validation and
authorization before mutation. Cancellation or early return closes the one-use
lane without replay and retains the healthy host. Smaller heaps or increased
admission concurrency are not guaranteed.

`parallelBuilds` freezes/deduplicates App stylesheet jobs after ordered discovery
and links outputs deterministically. CPU, memory and configured limits bound
concurrency: `maxWorkers` 1-8, `maxMemoryMb` 256-8192. This is admission estimation,
not a third-party RSS limit. Custom webpack/loaders, PostCSS pipelines and Sass
callbacks stay serial. Failure stops admission and settles started jobs before
discarding staging; the previous build survives. `manifest.buildParallelism`
records the actual stylesheet job count and concurrency.

### Automatic compact presentation (0.1.22-alpha)

Production Node App builds automatically optimize eligible large, pure display
components from 0.1.22-alpha, without a directive or configuration change:

```jsx
export default function Products({rows, title}) {
  return <section><h2>{title}</h2><table><tbody>
    {rows.map(row => <tr key={row.id}>
      <td>{row.label}</td><td>{row.total}</td>
      <td>{row.available ? 'Available' : 'Sold'}</td>
    </tr>)}
  </tbody></table></section>;
}
```

Official Flight references carry packed display slots instead of the expanded
element tree. Original props/expressions and unused private fields are omitted;
arithmetic, comparisons and text choices execute server-side. Only displayed
results/choices travel; hidden boolean children become empty slots. React keys
remain serialized. Authorization, IO, hooks and effects retain their normal
paths; an application's rendered data must still be authorized.

SSR HTML remains complete. The browser executes a compiled display template
using React's pinned protocol, without reconstructing records or a custom Flight
decoder. This is not zero JavaScript. Eligibility requires a synchronous pure
return, intrinsic HTML/fragments, literal styles, scalar reads and inline maps;
simple props/row destructuring and nested maps work. Scalar conditions stay on
the server; checked JSX branches transfer displayed choices, ambiguous ones stay
ordinary.

Post-0.1.22 source can extract checked blocks from modules with imports, async
work and other exports, preserving surrounding code/interactive siblings. It
never executes imports/functions during discovery. Elements passed to unknown
components, inspected/stored JSX and arbitrary callbacks stay ordinary because
their consumers may observe identity/props. Hooks, custom components/pragmas,
spreads, refs, events, raw HTML, computed access and effects remain ordinary, as
do native form/disclosure controls, media and canvas with browser-owned state.

Checked attributes are keys, data/ARIA, id, title, className, role, lang, dir,
tabIndex and htmlFor; styles must be literal. Other attributes, URLs and
document/resource elements retain React sanitization/resource behavior. A
component also imported by client code keeps its ordinary public props API;
only its dedicated Flight entry accepts packed slots.

Custom webpack/loaders, React aliases and per-directory TS/JS configs opt out.
An explicit build-wide standard React config may remain eligible; inherited
configs, custom JSX factories/sources do not. Config inspection is static,
bounded and shared, without executing config expressions.

Input must be plain own data and dense ordinary arrays. Getters, proxies,
instances, overridden array methods, opaque/non-finite values, shape mismatches
or exceeded limits fall back to the original server function. Limits are depth
32, 20,000 entries/array and 100,000 visited values. Projectors compile once
without eval or rendering both representations. The fused path validates into
locals and emits final slots without an intermediate input tree. Repeated
components need at least 32 rendered entries (cold cost can raise this); other
components need 64 intrinsic elements. These heuristics promise no speedup.

Runtime fallback carries ordinary server children through the same compiled
boundary, retaining its host root across size/shape transitions. That small
boundary still downloads; small-list speed or zero overhead is not guaranteed.
Development/Fast Refresh, Edge, Pages and builds selecting any htmlOnly route
retain existing rendering. HTML-only still has no Flight/hydration scripts.
Opt out with top-level `presentationComponents: false`. The former experimental
boolean remains an alias; conflicts fail. Optional `'use presentation'` strings
never relax checks. No shared page/user-data cache is introduced.

Unreleased after 0.1.22: used literals share structural templates. Checked DOM
plans adopt the real React root, identical SSR, keyed nodes, focus and selection;
ordinary React handles recovery. Flat packets can use official Flight binary
columns and direct SSR without rows; outer Flight decoding remains. Bounded
local scalar helpers and literal resource-free SVG are checked without executing
application imports. Literal subtrees can be prepared at build time, retaining
guards. These are not published 0.1.22 npm bytes.

Private `presentation-report.json` / build API `presentationReport` and CLI
counts expose compile eligibility plus DOM/packet/cold estimates, not proof that
all runtime shapes compacted. Packed positions are internal. Compare with
`node tests/performance/presentation-benchmark.mjs <output.json>`: unchanged
source, global off/on, identical rendered HTML/data, alternating dynamic SSR/
Flight windows, bytes, p95/p99, sampled owned-process memory and cold Chromium
transfer/execution/interaction. SQL, business logic and DOM costs remain;
browser JavaScript/memory can increase and no global multiplier is established.

Development refresh can target Server Action importers using dependency graphs
before/after the change. Unrelated tabs apply a deferred generation before
visiting changed routes. Unknown/incomplete graphs, bindings, runtime/routes,
global config, rewrites/middleware, i18n and parallel/intercepting routing keep
global refresh. Server generations publish whole; pending mutations never replay.

## React Compiler

Enable the bundled official compiler with `reactCompiler: true`; the default is
disabled and `false` preserves ordinary components. Babel needs no separate
installation. It optimizes project-owned browser components in Pages/App, dev/
production, and App Client Component SSR. Pages server code (including APIs,
Document and loaders), RSC, Actions, framework/generated code and npm packages
stay uncompiled, avoiding client-only hooks in ordinary server functions. Keep
matching required React 19 peers.

Babel can optimize ordinary `.mts`/`.cts` hook helpers; directives there remain
unsupported. Decorated typed helpers retain native compilation while their
importing React components can be optimized.

Options are `backend: 'babel' | 'oxc'`, `compilationMode: 'infer' | 'annotation'`,
`panicThreshold: 'none' | 'critical_errors' | 'all_errors'`, `target: '19'`.
Defaults: Babel, infer, none, 19; unknown fields fail. Annotation mode requires
`"use memo";` at the function start; `"use no memo";` opts a function out in
either mode.

For the explicit experimental Rust backend:

```sh
npm install --save-dev oxc-transform-react@0.157.0
```

```js
export default {reactCompiler: {backend: 'oxc'}};
```

Oxc is optional; Babel does not install its compiler/WASM/native binding.
Install in the application with optional platform dependencies enabled, even
with a global CLI. Missing/incompatible compiler/binding or compilation failure
fails explicitly; no backend fallback. JSX stays for the graph compiler while
Oxc removes TypeScript; App SSR uses its SSR output and browsers its client
output. Project/Action boundaries, source/loader maps and Fast Refresh remain;
unsupported options fail rather than passing through.

After a successful build, `prnext compiler` / `prnext compiler --json` shows
actual decisions. Babel reports project-relative functions, optimization/skips,
reasons and reused diagnostics; later stripping/tree shaking may omit functions.
Browser/SSR do not double-count functions. Incremental graph reuse can limit
coverage, which the report states; disabled mode is explicit. The last successful
report contains no source and stays private; failure preserves it.

Oxc reports backend/version and file diagnostics. Its API provides no function
success events, so unavailable totals do not mean zero optimized functions.
Cached diagnostics replay with backend/version/client-SSR cache identities.

Follow the Rules of React and verify hydration, interactions and Fast Refresh.
Compare production off/on: build work increases and versioned pure transforms
are cached; faster responses, smaller JS and multipliers are not guaranteed.
See the [React Compiler docs](https://react.dev/learn/react-compiler) and
[Oxc guide](https://oxc.rs/docs/guide/usage/transformer/react-compiler.html).

Only explicit private Next import adapters are supported. Do not add arbitrary
`next/dist/...` imports or another Next runtime to satisfy an import. Isolate or
replace that dependency, retain the original framework when necessary, and
state the limitation.


## Migrate conservatively

Use the project's existing package manager. For npm, install the intended
published PRNext release and its matching React peers, then inspect the dry run:

```sh
npm i --save-exact @thomas.f/prnext react@19.3.1 react-dom@19.3.1 react-server-dom-webpack@19.3.1
npx --no-install prnext migrate --dry-run
npx --no-install prnext migrate --check --json
```

Review scripts, manager/workspace detection, configuration and reported source
conflicts. When the plan is correct:

```sh
npx --no-install prnext migrate
npx --no-install prnext check --json
npx --no-install prnext typecheck
npx --no-install prnext build
```

Migration changes selected scripts/dependencies, backs up package files and
existing lockfiles, and keeps Next.js and application source. Public `next/*`
imports can remain. Do not remove Next, replace all imports or recreate the
application without a separate need.

Installation honors npm, pnpm and Yarn Classic/Berry and the owning workspace
root. Conflicting managers, unsafe filesystem entries and unlisted workspaces
can block automatic install. `migrate --no-install` prepares the manifest for
manual manager execution. Custom shell scripts may require a manual edit.
An installation failure attempts safe manifest/lockfile restoration; it cannot
roll back every dependency directory or manager cache. Never solve peer conflicts
by silently adding `--force` or `--legacy-peer-deps`.

`migrate --check` audits without applying a migration. Configuration evaluation
can run project code, and installed custom loaders still require a real build.
The audit is not a sandbox for untrusted projects.

The version 2 JSON report follows static imports from project sources into the
installed packages they reference. It checks explicit PRNext adapters and their
statically declared named exports, and includes the importing file, line and
import chain when a dependency uses an unavailable API. It resolves selected
Node, browser and React Server Component package conditions, including workspace
symlinks, without importing those package modules. Unreferenced packages are not
enumerated. Runtime branches, custom loader output and every possible bundler
condition remain outside this check.

A module-level `use server` directive is a server boundary even when a Client
Component reaches it through a re-export. Its dependencies are still audited in
the server context. A client dependency on a Node builtin needs an actual browser
implementation; package `browser` mappings and installed shims are resolved
before diagnosing it. Custom configuration aliases still require a build with
that application's configuration.

`evidence.state: "checked"` means the selected static graph was inspected, not
that migration is certified. `"unknown"` identifies unresolved/computed imports,
loader inputs or incomplete coverage. The graph is bounded to 2,000 modules,
12,000 imports, 32 MiB of source reads and 32 import hops. Hitting a limit leaves
the remaining coverage unknown. `ok` means no blocking diagnostic was found;
inspect warnings and coverage even when it is true.

## Compare running applications

Start the original application and the candidate on separate available ports.
Create `paths.json` with representative concrete URLs:

```json
["/", "/products/demo", "/api/health"]
```

Then compare public GET responses:

```sh
prnext migrate --check --against http://localhost:3000 --candidate http://localhost:3001 --routes paths.json
```

The comparison does not authenticate or follow redirects. It compares response
samples, including status, content type and selected body semantics; it does not
prove hydration, styling, actions or all dynamic routes. Visit important routes
in a real browser, test authorized and unauthorized states, and run the existing
application tests. Keep the original setup available until the candidate is
actually verified. Timings from this comparison are not controlled benchmarks.

## Run application browser scenarios

An explicit browser option can run the application's own assertions against
each server. Install Playwright and its Chromium browser in the application
using its normal development setup; PRNext never installs them for this check.
Provide a trusted `.mjs`, `.cjs` or `.js` module inside the application directory:

```js
// migration.scenarios.mjs
export default [
  {
    async run({page, baseURL}) {
      await page.goto(`${baseURL}/sign-in`);
      await page.getByLabel('Email').fill(process.env.MIGRATION_TEST_EMAIL);
      await page.getByLabel('Password').fill(process.env.MIGRATION_TEST_PASSWORD);
      await page.getByRole('button', {name: 'Sign in', exact: true}).click();
      await page.getByRole('heading', {name: 'Dashboard', exact: true}).waitFor();
      await page.getByRole('button', {name: 'Save note', exact: true}).click();
      await page.getByText('Note saved', {exact: true}).waitFor();
      await page.getByRole('button', {name: 'Sign out', exact: true}).click();
      await page.getByRole('heading', {name: 'Sign in', exact: true}).waitFor();
    },
  },
];
```

Replace the URLs and accessible names with the application's real controls.
Supply dedicated test account values through the command's environment rather than
command arguments or source files. Use isolated test databases: these explicit
callbacks execute application code and can submit forms or mutate data.

```sh
prnext migrate --check --against http://localhost:3000 --candidate http://localhost:3001 --routes paths.json --browser-scenarios migration.scenarios.mjs --timeout 15000 --json
```

Only this option loads the scenario module and starts a browser. It requires
the application's installed `playwright` or `@playwright/test`. Each callback
receives a new isolated browser context for each target. Assert observable
behavior inside the callback; its return value is ignored. A callback that
fulfills passes for that target, and a thrown assertion fails. Both targets
must pass independently; equal durations or response samples are not used to
infer browser equivalence.

The report records scenario numbers, targets and pass/fail results. It excludes
application console output, raw error messages, request data, cookies and
screenshots. Read or debug the original application test separately when a
generic failure needs investigation. Keep credentials out of assertion labels
and application-managed artifacts too. An unavailable browser or incomplete run
is reported as unknown. There are at most 20 scenarios, a 100–60,000 ms budget
per callback, a bounded startup period and a five-minute maximum for the worker.
A timeout closes its context and ends the run before another target starts.
The worker also closes its owned browser when it finishes. This is explicit
execution of trusted test code, not a sandbox for an untrusted module.

## Boundaries that often matter

React server/client directives in `.mts`/`.cts` are rejected; use `.ts`/`.tsx`.
App Route Handlers use Web Request/Response, while Pages APIs retain their own
request/response contract. App and Pages router hooks are not interchangeable.
Edge code cannot assume Node APIs or Node-only package behavior.

HTTP/1 WebSockets can tunnel through supported external HTTP(S) rewrites and
hosting gateways; App/Pages handlers do not gain a WebSocket server API. Static
imports accept completed public browser output, not another framework's SSR
server. See [Deployment](deployment.md) before choosing an adapter.

When a feature is missing, give its exact failing API/option and a supported
alternative. Do not claim full compatibility, invent a replacement method or
mask the error with an empty shim.
