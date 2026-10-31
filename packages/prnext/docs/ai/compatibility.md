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
Next.js 16.4.3, including mounted App navigation, form Actions and cookies,
metadata, Pages locale routing, redirects, APIs and selected webpack loader
contracts. These executable examples cover specific behavior; they do not
certify every Next.js application or plugin. `NextRequest.nextUrl` understands
data-route build IDs and locales, and request-cookie mutations synchronize the
request header. Request cookies have different mutation results from response
cookies; do not use them interchangeably.

A locked real-application fixture additionally exercises Better Auth 1.7.14
(email/password, session cookies and logout), Drizzle ORM 0.45.4 over SQLite
through its proxy driver, next-intl 4.14.9 (server and client translations),
and the MDX 3.1.1 webpack loader against Next.js 16.4.3. It covers authenticated
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

## React Compiler

Enable the bundled official React Compiler in the project's existing config:

```js
export default {
  reactCompiler: true,
};
```

No separate compiler installation is required. The default is disabled;
`reactCompiler: false` preserves the uncompiled component path. Enabled builds
optimize project-owned browser components in both Pages and App applications,
in development and production. App Client Components also use the transform in
their isolated server-rendering graph. The Pages server graph stays uncompiled,
including APIs, custom Document code and data-loader utilities, so ordinary
server functions never acquire client-only memoization hooks. React Server
Components, Server Action modules, PRNext internals, generated entrypoints and
npm packages are not compiled. Keep the matching React 19 peer versions required
by the installed framework.

Ordinary `.mts`/`.cts` hook helpers can be optimized; server/client directives
in those extensions remain unsupported. Decorated `.mts`/`.cts` utility modules
keep their native compilation path while importing React components can still
be optimized.

For gradual adoption, use `reactCompiler: { compilationMode: 'annotation' }`, then
put `"use memo";` at the beginning of each component or hook to optimize. In
either mode, `"use no memo";` excludes an individual function. Supported object
options are `compilationMode: 'infer' | 'annotation'`,
`panicThreshold: 'none' | 'critical_errors' | 'all_errors'` and `target: '19'`.
Defaults are `'infer'`, `'none'` and `'19'`; other fields are rejected.

After a successful build, inspect the compiler's actual results:

```sh
prnext compiler
prnext compiler --json
```

The report names observed functions, their project-relative files, optimization
or skip status, and the compiler's reasons. These are transform decisions;
server-code removal and tree shaking can later omit a function from the browser
bundle. Cached transforms retain their
diagnostics and are identified as reused. Browser and server graphs do not
inflate the function count. An incremental build can reuse graph inputs without
observing every transform; the report states that scope rather than claiming
complete application coverage. Disabled compilation is reported explicitly.
The report describes the last successful build, stays outside public assets and
does not include source code. A failed build preserves the previous report.

The compiler can skip code that cannot be safely optimized. Follow the Rules of
React and check actual behavior rather than assuming every component was
compiled. It reduces repeated component work; it does not guarantee faster
server responses, smaller JavaScript or a specific speed multiplier. Validate
hydration, interactions and Fast Refresh in the application, then compare a
production build with the option enabled and disabled. Compilation adds build
work; PRNext caches pure transforms with their compiler version and settings.

See the [official React Compiler documentation](https://react.dev/learn/react-compiler).

Only explicit private Next.js import adapters are supported. Do not add arbitrary
`next/dist/...` imports or install another Next runtime to satisfy one: isolate
or replace the incompatible dependency, retain the original framework where
needed, and describe the limitation honestly.

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
