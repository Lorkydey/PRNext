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
