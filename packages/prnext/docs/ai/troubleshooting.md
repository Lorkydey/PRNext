# Troubleshooting and live verification

[AI documentation index](../../AI.md)

## Compile large client imports only when used in development

For App Router applications, the explicit experimental option below keeps
literal client `import()` targets outside the initial browser graph. It defers
their transformation and compilation, rather than only downloading an already
compiled chunk later.

```js
// prnext.config.mjs
export default {
  experimental: { lazyDynamicImports: true }
};
```

The option affects `prnext dev` only. Production keeps its ordinary dynamic
chunks and does not use a development compilation endpoint. SSR also keeps its
normal behavior. A `next/dynamic` component with `{ ssr: false }` is a useful
candidate for an editor or other large browser-only feature; an import needed
by SSR still needs its server compilation.

On first use, the development server compiles the requested subgraph, publishes
its immutable assets, and loads its CSS before resolving the import. Already
loaded ESM dependencies are reused through their original module URLs, keeping
shared objects and live bindings. Once activated, the module participates in
subsequent JavaScript and stylesheet updates. A failed compilation can be
requested again after correcting its source.

Activated styles remain loaded for the generation, including when parallel
slots select their own styles. Prefer CSS Modules or selectors scoped to the
deferred feature when its global styles should not affect other components.

The initial scope is App Router applications using the native compiler, with
same-origin assets and no webpack hook or custom loaders. Literal imports from
project `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts` and `.tsx` sources are eligible;
computed imports, import attributes, literal requests containing `?` or `#`,
imports inside installed packages and typed `.mts`/`.cts` helpers keep the
ordinary compiler behavior. The compiler keeps the distinct module identities
of those literal query and fragment imports. If an alias or a transitive
dependency introduces a resolved query or fragment suffix inside a deferred
graph, activation returns an explicit error
before reusing any shared export bridge. Disable the option for that graph;
query and fragment identities in deferred graphs are not currently supported.
The compiler does not silently duplicate a shared CommonJS dependency: that
case returns an explicit error. Convert that shared dependency to ESM or disable
the option.
Server Actions first introduced only by a deferred graph also require a static
import or the ordinary compiler, because the running server implementation
cannot be extended by publishing browser assets alone.

There are at most 128 registered imports and 4,096 static JavaScript dependency
identities per generation. Deferred assets have a cumulative 128 MiB budget per
active generation. Existing development request and generation limits still
apply. Public requests contain opaque registered IDs, never source filenames;
an unknown ID cannot initiate a deferred compilation. Static ESM export bridges
have their own startup cost, so measure your application's initial build and
first-use delay before keeping the option enabled.

## Collect a useful failure

Read the installed version, command, working directory, Node version, manager,
configuration and first complete diagnostic. Separate build errors, semantic
TypeScript errors, server exceptions, HTTP failures and browser hydration
errors; they have different causes. Keep secrets, cookies and authorization
headers out of reports.

```sh
prnext --version
prnext check --json
prnext typecheck --json
```

`check` does not install, compile or start the application. `typecheck` generates
types and runs application-installed TypeScript; it needs the application's
tsconfig and may update generated references. `build` then exercises loaders,
server/client transforms and prerendering. A browser visit checks the live
result. Report which layer failed instead of treating one green command as proof
of all layers.

## Common diagnoses

| Symptom | Check first |
| --- | --- |
| Native component missing or wrong version | Optional dependencies, supported platform/Node, package lock, framework/native version family and an unintended `PRNEXT_BINARY` override. |
| Peer or React server/client mismatch | Exact installed React, React DOM and RSC peers; duplicate React instances and a second framework runtime. |
| Unknown configuration option | The installed version's accepted config; remove or replace only after understanding the intended feature. |
| Cannot resolve a framework import | Public supported subpath, dependency placement and the migration audit; do not fabricate a private adapter. |
| Hook or server-only import error | The nearest `'use client'` boundary and everything it imports; keep Node/secret code on the server. |
| Request API outside context | Move cookie/header access into a request; cached callbacks receive needed values as arguments. |
| Type errors missing from editor or build | Run `prnext typecheck`; inspect `typescript.tsconfigPath`, inherited roots and existing aliases. |
| A prerender needs runtime data | Decide whether the route is actually dynamic; do not insert build-time production credentials or suppress the bailout blindly. |
| Cached content remains stale | The affected cache layer, explicit key/tags and mutation-phase invalidation; custom handlers may delegate caching. |

Do not manually patch installed native binaries or force a different release
into an application. Reinstall through the existing manager and reviewed
lockfile if installation is the actual problem. Keep the original diagnostic
when reporting a platform that lacks a compatible published component.

## Hydration errors

Compare server HTML with the first client render. Typical causes include
`Date.now()`, random values, locale/time-zone differences, invalid HTML nesting,
browser-only conditions and client state initialized from storage. Pass stable
server values as props or move browser reads to a lifecycle. Check that the
browser loaded assets from the matching build. Use `suppressHydrationWarning`
only for a deliberately unavoidable, understood mismatch; it is not a general
repair. Verify the interactive result after the change.

## HMR and cache failures

Development compiles requested routes and preserves state for compatible edits;
config/environment, custom Document or incompatible module changes can reload
the document. Production prerendering and compression are not development HMR.
An unused route need not rebuild until requested.

Middleware and rewrites can select a cold destination after routing. PRNext
compiles that destination through its private development compiler and continues
the same request. It does not send an upload or action through middleware again.
Retained parallel branches are compiled together when their source is needed.
An error in an unrelated unopened route should not force that route into the
active graph. Safe mode remains available for full-graph comparisons.

For a controlled diagnosis, stop only the development process you own and try:

```sh
prnext dev --safe
```

Safe mode uses full builds and fresh workers. `PRNEXT_BUILD_CACHE=0` disables
PRNext's persistent compiler/build caches when set in the current process environment; use
the syntax appropriate to the user's shell and restore the previous setting
after the comparison. In-memory compiler/transform reuse is a separate layer.
Optional cache-storage failures should fall back to work,
while genuine loader errors remain build failures. Do not delete every cache or
lockfile as a first response, especially with another server running.

Production builds can reuse eligible compiled JavaScript graphs and CSS Module
outputs from the default CSS engine across processes through the private
`.prnext-cache` directory. The successful artifact's `compilation-cache-report.json` and the
programmatic build result's `compilationCache` report actual hits, misses and
bypasses. These are compilation diagnostics, not response-cache or latency
measurements. App graphs that discover actions or client boundaries, development
graphs, the explicit PostCSS engine and custom loader/PostCSS pipelines still
execute their compiler work.
HTML, Flight responses and private rendered data are not stored in this cache.
Changes to tracked dependencies, resolution candidates, options, environment
or framework identity invalidate eligible entries. Corrupt or unavailable cache
records fall back to compilation; `PRNEXT_BUILD_CACHE=0` disables their persistent reuse.

For production observations:

```sh
prnext start --inspect
prnext inspect --json
```

The inspector needs actual traffic for observed timings. Header-ready timings
exclude the full streaming body, and missing/dropped samples are not zero.
`prnext routes` describes compiled routes. Bundle size questions use
`prnext analyze`, after building, rather than interpreting request time as
compiler performance.

Initial-JS analysis includes required hydration imports and SSR-used dynamic
chunks. Schema 2 reports per-prerendered-path samples and the maximum size for
each compression metric; a route's file list can be the union of its samples.
Request-dependent or incomplete graphs are lower bounds. Their size budgets
fail as `initial-unknown`, even if that lower bound is small. Do not present it
as a complete measurement or a size saving. Rebuild old schema-1 baselines before
comparing them with schema 2. An opaque webpack graph is also marked incomplete.

For memoization questions, run `prnext compiler --json` after a successful build
with `reactCompiler` enabled. Inspect the affected function and its skip reason,
the reported graph coverage and cached-transform counts. An absent function in
an observed-transforms report is not proof that it was optimized or rejected.
Keep application behavior and hydration checks alongside this diagnostic.

## Connect the existing development MCP

Start `prnext dev` in the application, then configure a compatible assistant to
launch the following **stdio MCP command** with its absolute project directory:

```sh
prnext mcp /absolute/path/to/application
```

Use the locally installed executable, not an unreviewed remote package. This
stdio process is a tool server for an MCP client, not a second application
server. The development endpoint binds to loopback; its private
`.prnext-dev/tools.json` contains a capability, so never publish or paste that
file. No new shell-access tool or public debug endpoint is needed.

The existing tools include `dev_snapshot`, `dev_logs`, `dev_routes`,
`dev_route_ensure`, `dev_cache_invalidate`, `dev_source`, `dev_ai_context` and
`dev_verify`. Read their returned schemas rather than inventing tool arguments.

For a fix, capture `dev_snapshot` before editing and retain its `sequence`.
After the edit, call `dev_verify` with that value as `sinceSequence` and the
pathname being checked. Keep an actual application browser open. Verification
requires a newer successful generation and browser evidence that it applied
that exact build. A missing build or browser is inconclusive; compilation,
TypeScript or reported browser errors fail the observation. Continue relevant
application tests: this development observation does not establish complete
functional correctness.

Local MCP works independently of managed hosting. `prnext dev --host-ai` is an
explicit relay option for a logged-in terminal and a compatible connected Host
server; it can share requested diagnostics and queued context. Do not enable
remote sharing or change a user's assistant configuration as a hidden side
effect of fixing an application.
