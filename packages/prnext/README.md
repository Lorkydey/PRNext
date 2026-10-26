<p align="center">
  <a href="https://prnext.dev">
    <img src="https://raw.githubusercontent.com/Lorkydey/PRNext/main/.github/assets/prnext-logo.svg" alt="PRNext logo" width="112" height="112">
  </a>
</p>

<h1 align="center">PRNext</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@thomas.f/prnext"><img src="https://img.shields.io/npm/v/%40thomas.f%2Fprnext/alpha?style=for-the-badge&amp;label=npm&amp;labelColor=161b22&amp;color=007ec6" alt="Current npm alpha version" height="28" align="absmiddle"></a> &nbsp;
  <a href="https://github.com/Lorkydey/PRNext/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Lorkydey/PRNext?style=for-the-badge&amp;label=license&amp;labelColor=161b22&amp;color=98d6ac" alt="MIT License" height="28" align="absmiddle"></a> &nbsp;
  <a href="https://x.com/PRNextdev"><img src="https://img.shields.io/badge/-%40PRNextdev-171717?style=for-the-badge&amp;logo=x&amp;logoColor=white" alt="Follow @PRNextdev on X" height="28" align="absmiddle"></a>
</p>

A Rust-powered web runtime with React rendering on Node.js and a static adapter for completed browser builds.

> **Very early alpha.** Built for experimentation and feedback. Next.js compatibility is partial; expect bugs, missing features and breaking changes.

## Documentation for AI assistants

The npm package includes a short `AI.md` guide and focused
documentation for setup, routing, data, migration, deployment and troubleshooting.
Read the guidance for the version actually installed, without a network request
or a native server:

```sh
prnext docs --ai
prnext docs --ai quickstart
prnext docs --ai --list
prnext docs --ai routing --json
```

To help an assistant discover the guide, explicitly run
`prnext docs --ai --init` in your application. This adds a short managed pointer
to its `AGENTS.md`, preserving existing instructions. Installation does not edit
your project. Assistants do not all discover dependency documentation on their own.

## Development

Run `prnext dev` for requested-route compilation, React Fast Refresh, stylesheet
updates and an error overlay. Links do not prefetch pages in development. Open
browser tabs pin their routes; `onDemandEntries` controls inactive retention
(default: five routes, 60 seconds, bounded to 64 inactive routes). Middleware,
rewrites and parallel/intercepting routing conservatively compile the full graph.
Shared layouts, error infrastructure and imported dependencies are still built.

One Rust listener keeps its port and SSE connections open across saves. New
render generations activate only after binding; old responses drain for up to
30 seconds. Three immutable asset generations remain available. This replaces
render backends, rather than replacing arbitrary live Node modules in place.
Compatible component/style edits preserve React hook state; config, environment,
custom Document and incompatible module changes may reload the document.

A round PRNext indicator opens compact developer tools at the bottom-left: live
build/connection feedback, dismissed issues and page reload.
Two short red arcs flag non-blocking TypeScript or recoverable hydration issues;
a full red ring flags critical build or runtime errors. Recoverable hydration
issues stay available under View issues without opening an overlay automatically.
Opening the menu gathers the red indicator into a short stroke that follows the
left edge of the controls to View issues, then draws its outline in place.
Closing reverses the motion.
Reduced-motion settings switch directly between states.
Error details list the current issues above the selected diagnostic and mapped
source. Copy for AI prepares all listed errors; Send to AI opens the selected
error in the assistant workflow. Full messages and stack traces stay collapsible.
Compilation keeps its blue loader; reduced-motion settings disable ring animation.
Hide it until reload from the panel, or disable it with
`devIndicators: false` without disabling error overlays or Fast Refresh.
`devIndicators: { position: 'bottom-right' }` also accepts `bottom-left`,
`top-left` and `top-right`. Drag the logo to snap it to any corner, or focus it
and use Alt + arrow keys. The choice survives reloads in the current tab;
changing the configured default resets it. The indicator is isolated from
application styles and is not included in production browser bundles.

The near-black menu grows from the logo as a connected bubble and retracts on
close. Transitions reverse smoothly if interrupted, and reduced-motion settings
show the same controls immediately.

The indicator also opens a console with Browser/Server source filters, log levels, search, pause, clear
and copy controls. Select a message to read or copy its complete captured text.
Copy for AI prepares the visible logs with route context; its menu can copy all
recorded errors, including those hidden by filters, with a correction prompt and
repeated errors grouped. Query strings and fragments are omitted from route
context. It captures browser console messages, uncaught errors and unhandled
promise rejections while preserving native console output. Up to 500 messages
and 2 Mi characters stay in memory in that page; individual messages retain up
to 128,000 characters with an explicit truncation note beyond that limit. Values
are text snapshots. A reload clears browser messages. Local tools stay on this
machine unless you explicitly enable the Host AI relay described below.

Inspect opens real browser/server requests, measured build and refresh timings,
and a searchable route list. Compile a dynamic pathname on demand or invalidate
its native page/data cache without clearing unrelated routes, restarting the dev
generation or deleting persistent compiler caches. Cold routes and custom cache
handlers report their limitations instead of claiming an invalidation occurred.
Request details omit query strings, headers and bodies. Missing timings are
shown as not measured; request time is not presented as a compiler benchmark.

Errors resolve to original project source with a code frame and an editor link.
Select a component first. If no assistant is connected, a compact connection
dialog keeps your selection while you set up MCP. Sending unlocks after an
assistant completes the MCP handshake; copying a configuration does not connect
it. Connection settings then collapse. If it disconnects, your draft is preserved
until you reconnect, and local component selection remains available.
Client configuration opens smoothly, with a short scrollable code preview, full
configuration copy and an optional setup guide for the selected assistant.

Select element for AI captures its source marker, relevant styles and a bounded
PNG of the selected DOM element. Screenshots exclude form controls and embedded
frames; cross-origin assets can prevent capture. Sending queues context for the
assistant to read through MCP; it does not start an idle assistant or claim a fix.

### AI development tools

An assistant running locally can connect with the MCP stdio command below.
Use the absolute project directory when the assistant has another working directory:

```sh
prnext mcp /absolute/path/to/project
```

The private discovery file is `.prnext-dev/tools.json`. The authenticated tool
service binds only to loopback and exposes bounded project diagnostics, source
excerpts, route compilation and native cache invalidation. It provides no shell
or arbitrary file access. Browser diagnostics and capabilities are development-only.

To reuse your existing PRNext Host MCP connection instead of configuring another
MCP server, opt in from a terminal already logged into Host:

```sh
prnext login
prnext dev --host-ai
```

This requires the corresponding Host development-relay update. An older Host
reports that the relay is unavailable while local development and local MCP keep
working. The terminal pulls allowlisted requests from Host; it never uploads its
localhost capability or exposes a public development URL. The existing AI
connection's workspace, project permissions and revocation still apply. Host
receives requested development diagnostics and explicitly queued context,
including screenshots. An unlinked project requires an AI connection with access
to all projects. Stopping dev closes the shared session; timed-out commands are
not automatically replayed.

The tools include `dev_snapshot`, `dev_logs`, `dev_routes`, `dev_route_ensure`,
`dev_cache_invalidate`, `dev_source`, `dev_ai_context` and `dev_verify`.
For a correction loop, read a snapshot, edit the source, then call `dev_verify`
with that snapshot's `sequence` as `sinceSequence` and the pathname to check.
Verification requires a newer successful generation and an open browser that
actually applied that exact build. No new build or no browser evidence returns
inconclusive. Reported compilation, TypeScript and browser errors fail the check;
this observation does not replace application tests.

The compact screen selector offers Desktop, Phone (390 × 844) and Tablet
(768 × 1024), with width tooltips and a highlighted active mode. Previews use a
separate, same-origin page with real CSS viewport dimensions, smooth device
rotation and their own client console. A minimal dark toolbar controls the
centered phone, tablet or desktop frame. Toggle Frame to hide the decoration without reloading; this
choice also survives reloads in the tab. A side handle adjusts width by dragging
or using the arrow keys. Compact hover and keyboard tooltips show device sizes
and preview actions; Escape dismisses a tooltip while keeping the preview open.
Phone and Tablet hide desktop scrollbars while keeping
scrolling available; Desktop restores the application's scrollbar styles.
Changing sizes preserves the preview's state; Desktop
fills the available canvas and Close returns to the original page. This previews
responsive layout, not a different user agent or touch hardware. Sites that block
framing must use the browser's device tools instead.

The pop-out icons open the console or device preview in separate windows. The
console remains connected to its source, with its filters and copy controls;
the dock icon brings it back. Device pop-outs keep their selected dimensions,
orientation, frame preference and URL, but opening or docking them starts a fresh
preview instance.
Reloading or closing the source closes its tool windows. Desktop opens a normal,
independent app window. The browser may require popups to be allowed for the site.

Pure transforms persist in `.prnext-cache/transforms-dev-v1`, independently of
production entries. The compiler also uses a private V8 cache, pruned at compiler
startup toward 64 MiB / 2,048 files. Cache failure falls back to recomputation;
`PRNEXT_BUILD_CACHE=0` disables PRNext's build/compiler caches. No application
responses, module state or Server Action keys are reused.

Loader cache corruption, unavailable storage and failed dependency snapshots
are cache misses, not build failures. Loader execution errors still fail the
build. Development Webpack sessions retain up to six compilers with bounded
memory caches; configuration, environment and plugin identity changes invalidate
them. Opaque recreated plugins may require a fresh compiler. Safe mode disposes
these sessions; production Webpack builds remain one-shot.
Map/Set and binary option values are compared explicitly; opaque configuration
data uses a fresh compiler. Replace a plugin instance when an unchanged function
captures external state that is invisible in its configuration.

CSS-only updates rebuild the bundles whose recorded dependencies changed and
retain other stylesheet URLs. Changed CSS Module exports still require a full
build. Large HMR dependency graphs use compact, bounded control frames and an
atomic commit; capacity failures report a diagnostic and use complete refreshes.

Pages data functions run on request, including `fallback: false` validation.
Offline HTML prerendering and gzip/Brotli generation remain production-only.

CSS uses native Rust-based Lightning CSS by default, with the project's
Browserslist targets. Custom PostCSS configurations, including Tailwind, keep their
plugin pipeline. `cssEngine: 'postcss'` selects the previous default pipeline;
`'lightningcss'` requests the native defaults but still respects a custom pipeline.
Sass compilation, CSS Modules and relative asset rebasing remain supported.

With an existing `tsconfig.json` and application-installed TypeScript, a separate
watch process reports semantic errors in the overlay without blocking serving.
It emits no application JavaScript. `typescript: {devChecks: false}` disables
this watcher. Its incremental metadata lives in the private project cache.

Enable `typedRoutes: true` to generate route suggestions and check literal links,
router navigation and parameter objects. PRNext maintains
`.prnext-types/routes.d.ts`, references it from `prnext-env.d.ts`, and adds that
helper to the selected tsconfig's roots while preserving its JSONC comments and
existing/inherited roots. Missing `next` / `next/*` TypeScript aliases are bound
to PRNext declarations; existing aliases stay authoritative. Route additions/removals
refresh the declarations.
For dynamic paths, use the encoded route helper:

```ts
import {route} from '@thomas.f/prnext';
router.push(route('/users/[id]', {id: 'alice'}));
```

This is PRNext's route registry, not the Next.js TypeScript language-service plugin.
Keep generated `.prnext-types/`, `.prnext-dev/` and `.prnext-cache/` out of Git.

Generate declarations and check types independently of application compilation:

```sh
prnext check --json
prnext typegen --json
prnext typecheck --json
```

`check` reports configuration, routes, React, TypeScript, supported Node and
native installation diagnostics without installing or compiling anything.
`typegen` and `typecheck` require application-installed TypeScript and an
existing tsconfig, including `typescript.tsconfigPath`. They generate route
declarations unless `typedRoutes: false`, report changes to the selected tsconfig
and `prnext-env.d.ts`, and preserve JSONC comments and inherited settings.
`typecheck` fails real type errors even with `ignoreBuildErrors: true`.

## Production build tools

`prnext build --watch` retains bounded compiler graphs and rebuilds production
output on source changes. It does not serve the application. Ordinary one-shot
builds keep using the persistent transformation cache. Each incremental build
uses fresh Server Action keys and an isolated prerender process. Configuration,
lockfile and environment-file changes recycle the watch compiler. Stop with Ctrl+C.

Integrations can use `const builder = await createBuilder(root)` from
`@thomas.f/prnext`, call `await builder.build()` after changes, and always finish
with `await builder.dispose()`.

```sh
prnext analyze
prnext analyze --json
prnext analyze --max-js 150
prnext analyze --baseline ./baseline.json --metric brotli --max-increase-percent 5
prnext analyze --metric gzip --budgets ./bundle-budgets.json --json
```

The default metric is raw JavaScript. `--metric raw|gzip|brotli` selects the
budget and comparison metric. `--max-js` is decimal kB per route;
`--max-increase-bytes` and `--max-increase-percent` limit growth against
`--baseline` (a saved build-analysis.json) or the previous build.
Per-route JSON budgets map exact patterns to those same limits, for example
`{"/": {"maxJs": 150, "maxIncreasePercent": 5}}`. Missing baseline routes fail
regression budgets instead of silently passing. Budget failures exit 1; invalid
arguments or analysis inputs exit 2. Reports include gzip/Brotli sizes, the
largest modules and previous-build changes. Shared chunks are counted once per route; statically
reachable App client boundaries are included. Conditional boundaries can
exaggerate actual traffic; arbitrary dynamic imports, CSS, fonts and images are
excluded. This covers React builds, not imported static HTML. Analysis files stay
in the private build root, outside public assets.

Optional startup module preloading in `prnext.config.mjs`:

```js
export default {
  workerPreload: { routes: ['/', '/api/health'], maxRssMb: 256, timeoutMs: 5000 },
};
```

This initializes one render host and, when needed, its RSC isolate before accepting
traffic. Choose up to 16 existing Node route patterns; Edge is unsupported. No
page render, data hook, action or API handler is invoked. Module initialization
does execute, including import side effects. RSS is a soft threshold between
imports, not a hard process cap; a single import can exceed it. Worker retirement
still applies. Failed/timed-out preloading is logged; ordinary requests can retry.

Persistent replacements retain their previous process for 15 seconds after a
successful traffic switch. A crash or three consecutive failed health probes
triggers rollback if the previous process is still healthy. Configure this with
`pstart --rollback-window 30000`, or `0` to disable (maximum 120000 milliseconds).
`pstatus --json` shows the window and rollback reason. Manual stop cancels
monitoring. Both processes consume memory during this window; rollback does not
undo database changes, shared assets, dependency changes or external side effects.

HTTP/1 WebSockets tunnel through external HTTP(S) rewrites, `pstart` and
`prnext host`, with streaming/backpressure and lifetime accounting. The upstream
must implement WebSockets; Pages/App handlers do not gain a WebSocket server API.
Other protocols, CONNECT and incomplete handshakes are rejected. Active tunnels
protect a host from idle retirement; persistent drain deadlines close remaining
tunnels. Payloads are not buffered in full or replayed.

## Install & upgrade

Node.js **22.23.4+, 24.22.1+ or 26.12.1+** · Windows, macOS and Linux glibc · x64 and ARM64

<details>
<summary><strong>Install · migrate an existing Next.js app</strong></summary>

Run these commands from your application directory. The current alpha requires matching React, React DOM and React Server Components versions:

```sh
npm install @thomas.f/prnext@alpha react@19.3.1 react-dom@19.3.1 react-server-dom-webpack@19.3.1
npx --no-install prnext migrate --dry-run
npx --no-install prnext migrate
npx --no-install prnext check
npx --no-install prnext dev
```

Review the dry run before applying migration. Migration backs up your package files and keeps Next.js and your application source. Compatibility checks help find issues; they do not guarantee that every Next.js feature works.

Migration detects npm, pnpm and Yarn Classic/Berry from the declared manager and
lockfiles, and installs from the owning workspace root. Only the selected app
manifest is migrated; Yarn may resolve the shared dependency graph. Conflicting
managers, unlisted workspace packages and unsafe filesystem entries block
automatic installation; `--no-install` prepares the manifest for manual review.
Failures restore saved manifests and lockfiles when safe. Dependency directories
and manager caches can contain partial installation results and are not rolled
back. No global manager installation or forced peer-dependency bypass is used.

Install only `@thomas.f/prnext`. Keep optional dependencies enabled: npm installs the matching native component automatically. Rust is not required to use a published release.

`reactCompiler: false` is supported; enabling React Compiler still fails explicitly.
`typedRoutes: true` enables PRNext's generated route declarations (see Development).

The current source candidate also supports `devIndicators: false`, configured
`experimental.optimizePackageImports` for pure ESM barrels with `sideEffects: false`,
and App Router `maxDuration` values from 1 to 300 seconds. Import optimization
preserves client/server boundaries and falls back to normal bundling when a barrel
cannot be safely expanded. Duplicate App convention files follow `pageExtensions`
priority and emit a warning. Identical public/App metadata files are accepted;
conflicting content still fails explicitly. Route Handlers can call shared
`use server` functions directly; pages retain their Flight/Server Action
registrations. Mixed npm component exports preserve the real React server
instance without requiring unused client hooks to exist in that environment.

Node Route Handlers and Server Actions can use `after()` from `next/server`. Callbacks run after the
response finishes or disconnects, including error responses, and retain their
request context. Tracked work prevents idle worker retirement without blocking the
next HTTP request. There are at most 128 tasks per request, within `maxDuration`
(25 seconds by default, including the response's running time). Cookie reads are supported;
post-response cookie writes are rejected. Server Actions wait for the HTTP response
to finish, not just their intermediate Flight render. Server Component and Edge
`after()` lifecycles are not implemented and fail explicitly. `revalidateTag`,
`revalidatePath` and `updateTag` are also rejected inside an `after()` callback;
perform supported invalidation in the Route Handler or Server Action before
returning. This differs from the full Next.js lifecycle. During service shutdown,
the 30-second standalone drain (35 seconds for global Host shutdown) can shorten a route's larger `maxDuration`. Ordinary sleep/eviction instead allows a 300-second drain. Forced
termination, a memory-budget violation or a machine failure can still interrupt
work; use durable external job storage for tasks that must survive these events.

`experimental.proxyClientMaxBodySize` accepts a byte count or a size such as
`'25mb'`, up to 32 MiB (default 10 MiB). Like Next's body clone, overflow retains
only complete chunks before the limit and warns; a chunk crossing the limit is
discarded. General request ingress remains capped at 32 MiB and Server Actions at
8 MiB. PostgreSQL's `pg` stays external by default so its optional native driver
remains lazy; explicitly putting `pg` in `transpilePackages` opts out.

The unreleased 0.1.17 candidate also persists pure transformations and
prepared runtime bundles under `.prnext-cache`. Cache keys include framework and
tool versions, source/options, project dependencies and environment fingerprints.
Corrupt entries are discarded; builds still generate fresh manifests and Server
Action registrations. `PRNEXT_BUILD_CACHE=0` disables these two caches.

Node workers use `.prnext-cache/node-compile-v1` for V8 bytecode, with startup
pruning toward 128 MiB / 4,096 files. This caches compilation, never module globals
or page responses; it is not a filesystem quota.
`PRNEXT_WORKER_COMPILE_CACHE=0` opts out; explicit `NODE_COMPILE_CACHE` and
`NODE_DISABLE_COMPILE_CACHE` settings take precedence. Cache directories contain
private compiled code: keep `.prnext-cache` out of source control and public roots.
Deleting them is safe when no build or worker is using the project.

Immutable HTML and browser assets now receive validated `.br` and `.gz` sidecars
when compression saves bytes. Rust serves the negotiated representation directly;
mutable public files and dynamic responses are not Brotli-precompressed.
`pstart` uses one shared Rust HTTP proxy per supervisor, keeping health checks,
restart/stop recovery and logs in its existing Node lifecycle manager. HTTP/1
WebSockets tunnel to configured upstreams; other protocol upgrades are rejected.

Google font build inputs are cached under `.prnext-cache/fonts-v1` (64 MiB,
256 entries, verified content hashes). A warm cache permits offline rebuilding;
a cold build still needs access to Google's font endpoints. Remove this cache to
refresh downloaded font inputs. This does not cache dynamic page responses.

Set `typescript: {}` to check an existing `tsconfig.json` during production builds
using the application's installed TypeScript. `typescript.tsconfigPath` selects
its configuration, including inherited aliases. `ignoreBuildErrors: true` skips
that production gate. Omitting `typescript` keeps production transpile-only;
development checks run independently in the background unless `devChecks: false`.
Checks do not emit application files or install packages. Only opt-in typed route
generation adds declarations and adjusts tsconfig roots as described above.

</details>

<details>
<summary><strong>Upgrade · update an existing PRNext project</strong></summary>

Stop your development or production process before changing dependencies. If you use `pstart`, follow the [persistent app upgrade guide](#upgrade-persistent-apps) first.

```sh
npm install @thomas.f/prnext@alpha react@19.3.1 react-dom@19.3.1 react-server-dom-webpack@19.3.1
npx --no-install prnext --version
npx --no-install prnext check
npx --no-install prnext build
```

Then restart your app with its usual command; for a foreground production server:

```sh
npx --no-install prnext start
```

This updates the existing `@thomas.f/prnext` dependency and its native component together. You do not need to migrate an already-migrated project again. Commit the updated package manifest and lockfile.

Use `@alpha` to select the current alpha release. `latest` is a separate npm tag; a dependency already installed in a project does not change until you update it.

</details>

<details>
<summary><strong>Build & run · development and production</strong></summary>

For development:

```sh
npx --no-install prnext dev
```

For production:

```sh
npx --no-install prnext build
npx --no-install prnext start
```

The portable command is `prnext`. The shortcut `prn` is available in compatible shells. On Windows 10 and Windows Server 2022, use `prnext`: [Windows reserves the name PRN](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).

</details>

<details>
<summary><strong>Runtime profiles · balanced, speed, memory and classic</strong></summary>

Balanced is the default. Set a profile when starting the production server:

| Profile | Command | Priority |
| --- | --- | --- |
| Balanced | `npx --no-install prnext start --profile balanced` | Memory, CPU and response times |
| Speed | `npx --no-install prnext start --profile speed` | Throughput and responsiveness |
| Memory | `npx --no-install prnext start --profile memory` | Lower memory usage |
| Classic | `npx --no-install prnext start --profile classic` | Original runtime settings |


Worker retirement can be configured in `next.config.mjs` (PRNext extension):

```js
export default {
  workerRetirement: { idleSeconds: 300, laneIdleSeconds: 30, keepWarm: false },
};
```

Values are resolved **per field**: CLI > process environment > built configuration > profile.
The CLI options are `--worker-idle-seconds`, `--lane-idle-seconds`, and
`--keep-warm [true|false]` (a bare flag means true). The corresponding environment
variables are `PRNEXT_WORKER_IDLE_SECONDS`, `PRNEXT_LANE_IDLE_SECONDS`, and
`PRNEXT_KEEP_WARM` (`true`/`false` or `1`/`0`). Seconds must be integers from 0 to
604800; invalid supplied values fail even when a higher-priority value exists.
Configuration-file changes require a new build; CLI/environment changes require
restarting the server.

`idleSeconds: 0` disables host idle retirement. `laneIdleSeconds: 0` disables
early retirement of surplus lanes; the host deadline still applies to those
lanes. Set both to zero to disable all idle retirement. `keepWarm: true` overrides
the resolved host deadline and retains one primary lane per used host, while
surplus lanes still retire. It creates no workers or artificial requests before
real traffic. To restore a shorter CLI deadline when a lower-priority source sets
`keepWarm: true`, also pass `--keep-warm false`. Active requests across **all**
lanes reset the host deadline; streams and tracked post-response work remain
protected. Keeping a host warm trades retained memory for lower wake latency;
it does not change the profile's response, buffer or V8 limits.

New builds include `runtime-contract.json`, separately declaring transport and
lifecycle versions and fingerprints of the runtime modules. `start` and
`host --check` reject missing, incompatible, future or mixed dynamic runtimes
before accepting traffic and print `prnext build <project>`. Rebuild and restart after
updating PRNext. Keep the selected production build immutable while it is in
use; this is a startup check, not a continuous file watcher. A copied metadata file cannot upgrade old runtime modules;
`--worker` must remain inside the verified build runtime directory. This is
artifact consistency checking, not a signature or a sandbox. Legacy builds
without any worker routes or middleware can still serve files without Node.
The multi-app `host` supervisor's whole-application `idleSeconds`/memory policy
is separate: keeping a Node worker warm does not override application sleep,
shutdown or resource-budget termination.

`prnext start` sizes Tokio's blocking I/O pool to four times the larger of its
runtime thread count and requested render workers (minimum 4, maximum 256).
`PRNEXT_BLOCKING_THREADS=1..1024` explicitly overrides it. This bounds threads,
not the number of incoming HTTP connections. Filesystem admission separately
bounds submitted blocking work and file response bodies, including slow clients:

| Environment variable | Default | Accepted range | Scope per server process |
|---|---:|---:|---|
| `PRNEXT_FILE_CONCURRENCY` | 64 | 1–4096 | File preparation and live file source bodies |
| `PRNEXT_FILE_WORK_CONCURRENCY` | 16 | 1–1024 | Submitted static/path/cache helper tasks, queued or running |
| `PRNEXT_FILE_QUEUE` | 128 | 0–4096 | Waiting callers at each admission gate; 0 rejects immediately |
| `PRNEXT_FILE_WAIT_MS` | 2000 | 1–60000 | Maximum admission wait at each gate |

Invalid values fail startup before listening. Full queues and admission timeouts
return HTTP 503 with `Retry-After: 1` and `Cache-Control: no-store`. These deadlines
apply to admission, not the duration of an accepted response. Cancelling a queued
caller releases its slot. An already running filesystem operation keeps its
permit until it settles, including a pending file read after a client disconnects;
an operating-system call cannot be forcibly cancelled safely. Large file bodies
use a one-frame channel with backpressure. Without an explicit whole-request
timeout, no deadline cuts off an active stream.
Their asynchronous open/read operations retain a file-response permit; they are
not included in the helper-task queue counter. These controls are not a global
limit on application or background I/O.
The limits do not bound TCP/kernel buffers or all HTTP connections, and an
unresponsive disk can occupy the bounded capacity until its operation returns.
Pages cache lookups use the same bounded filesystem admission. Their overload
follows the existing page-capacity 503 path, including Pages JSON requests;
it does not invoke error-page generation or regenerate a valid cached page.

File operations stay off the async runtime threads; HTTP validators, range
handling and path confinement are unchanged. The multi-app supervisor retains
its existing pool sizing because
its long-lived child-output readers have different requirements.

For local diagnosis only, `PRNEXT_METRICS_FILE=<path>` adds one observer thread
and cumulative counters once per second (file wraps at 16 MiB). It reports
Tokio threads, instrumented filesystem tasks/queues and worker events. Nested
filesystem timings are wall time, not CPU, and must not be added together.
`fileAdmission` and `fileWorkAdmission` report occupancy, peaks, submitted and
released work, rejections, timeouts, cancelled waits and wait duration. Their
`waitingHeaderBytes` estimate counts URI and header content only; it excludes
allocation overhead, request objects, bodies and TCP/kernel buffers. Use process
memory measurements for the total footprint. Metrics never initialize admission
settings or override values selected at startup.
`activeJobs` counts transport jobs in the shared worker pool;
`queuedJobs` excludes HTTP callers waiting before transport admission.
`laneIdleRetirements` includes release of a cancelled lane's retained host
reference, so it is not a count of distinct TCP connections closed. Host starts
and watchdog kills are separate events; RSC isolate restarts do not have an
independent cumulative counter. Normal operation has no observer thread or
sampling timer.
`--inspect` additionally records Node startup, module and RSC initialization
phases; use uninstrumented runs for throughput comparisons.

`prnext inspect --json` also reports fixed request stages: admission, render
start, request-body admission/read, worker queue/first byte/headers, HTTP headers,
response body and total lifetime. Completed, failed, cancelled and timed-out
samples are distinct; byte and concurrency budgets report occupancy, peaks and
rejections. Stages overlap and are not CPU timings. Local OTLP export includes
`prnext.request.stage.duration`; neither metric includes query strings, request
headers or body content.

`PRNEXT_QUEUE_WAIT_MS=1..3600000` sets the worker/body queue wait (default
30000 ms); render admission and start share one queue deadline.
`PRNEXT_REQUEST_TIMEOUT_MS=0..3600000` optionally limits the whole HTTP lifetime,
including upload, middleware and response consumption by the HTTP layer.
The default 0 disables it. Expiry before headers returns 504; expiry after
headers terminates the stream and releases its capacity, including when the
consumer stops polling. This is not proof of delivery to a remote client.
Completed responses do not cancel tracked `after()` or cache finalization work.
Route `maxDuration` remains an independent render limit.

Render workers start on demand. Idle connection lanes retire after 30 seconds in `memory` and legacy `compact`. `balanced` keeps each host's primary lane warm for 300 seconds and retires surplus lanes after 30 seconds; `speed` and `classic` keep primary lanes warm and retire surplus lanes after 30 seconds. Retirement waits on idle deadlines rather than polling. Active responses and streams retain their lanes, and tracked application work keeps its Node host available even after the last lane retires. New requests can reuse that host while cache finalization continues. Once the work settles, the existing heartbeat releases this retention within one second. Releasing idle workers lowers retained memory but adds worker startup and module loading to the next request.

Client disconnections release response permits and close incomplete transport lanes while retaining a healthy shared Node process. A lane whose terminal frame was fully validated can be reused. App Router cancellation pressure pauses new admission until abandoned work settles, with bounded queues and the original request deadlines; it does not immediately terminate unrelated responses. Successful response completion ends the RSC response deadline, while cache writes remain tracked until settlement. During this post-response work only, a shared watchdog probes the RSC isolate every five seconds and retires it if an acknowledgement takes more than 30 seconds. This measures responsiveness, not the total duration of asynchronous cache work; no RSC watchdog timer runs when that work is absent. Existing limits on cancelled requests and other API or middleware background work still apply.

Explicit disposal of a worker pool starts a separate graceful shutdown: tracked work has up to 30 seconds to drain before Rust terminates and reaps the process, including a blocked JavaScript event loop. This shutdown grace does not limit normal idle cache finalization. Arbitrary detached tasks are outside the tracked lifecycle; applications that rely on them or long-lived in-process state should use `speed` or `classic` to keep their primary host warm. Such tasks are still not preserved across shutdown or worker failure.

Each profile keeps its own admission, buffering and idle policy. Limits below are per worker host; render starts and live responses are separate budgets.

| Profile | Render starts | Live responses | API concurrency | Response buffer | Primary idle deadline |
|---|---:|---:|---:|---:|---|
| `balanced` | 16 | 32 | 256 | 4 MiB | 300 seconds |
| `speed` | 32 | 128 | 512 | 16 MiB | Keep warm |
| `memory` | 8 | 28 | 64 | 1 MiB | 30 seconds |
| `classic` | 16 | 32 | 512 | 8 MiB | Keep warm |

On Linux with Node's `process.execve` available (Node 22.15+/23.11+), production `prnext start` replaces its CLI process with the native server. This removes a resident Node launcher from every profile without shrinking render or response budgets. Rust handles SIGINT, SIGTERM and SIGHUP gracefully; Linux also kills Node workers if their native parent dies, including when JavaScript is blocked. Explicit `--shutdown-on-stdin-eof` remains supported. Windows, macOS, older Node versions, IPC callers and Node instrumentation keep the supervised launch path. Only heap-sizing Node flags are eligible for replacement; other flags and `NODE_V8_COVERAGE` conservatively retain supervision. Node still labels `process.execve` experimental. This change does not remove the supervisors used by `pstart`, or change `host` and development mode.

`balanced` keeps its 4 MiB V8 semi-space without `--optimize-for-size`. `speed` keeps its 16 MiB semi-space, larger concurrency and buffers, and warm hosts. `memory` keeps V8's size policy and early retirement; `classic` preserves its original V8 settings. Node heap flags can take precedence over the RSC isolate's young-generation resource limit: these settings are not total RSS caps. The earlier Windows V6 validation includes three 30-second measurements per scenario and a one-hour mixed endurance run; it predates this launcher change and is not an endurance result for this candidate. Workload and platform affect the CPU/RSS trade-off; a comparable Linux Nginx benchmark remains pending.

An explicit `NODE_OPTIONS="--max-semi-space-size=4"` (including Node's underscore spelling) overrides the profile's nursery policy. PRNext also omits `--optimize-for-size` in that case: on Node 24.19.0, V8 otherwise replaces the explicit value with 1 MiB. This opts out of V8's broader size policy as well, so CPU and memory consumption can change; measure the chosen value for your workload. It does not add an old-generation heap limit or change the profile's admission, response buffers or idle retirement. Without an explicit override, PRNext uses the defaults of the selected profile.

The V6 multi-application campaign keeps `start` on `balanced` and `host` on
`memory`. With one shared CPU on Windows, `memory` completed both short trials
at four applications / 512 MiB and eight applications / 1 GiB without allocation
limit events. Its one-hour validation used four applications / 1 GiB, not those
lowest budgets: 1,626,564 useful responses and 960 intentional cancellations,
with no HTTP or validation errors. `balanced` gave lower neighbouring-application
tail latency when the larger memory budget was available. These are independent
`start` instances, not a benchmark of the hosting proxy. Windows commit limits,
an active pagefile and process RSS sums are not Linux cgroup/PSS measurements;
equivalent Linux density and endurance measurements remain pending. The local V6 report retains failures,
variability and the small-static throughput cost of bounded admission.

The filesystem work limit remains 16, the setting validated under overload and
throughout the final endurance run. An explicit `PRNEXT_FILE_WORK_CONCURRENCY=64`
improved small-file throughput by about 5% in two short configuration trials,
but allows four times as many submitted helper tasks. It has not received the
same endurance validation and is not a universal profile improvement.

Results depend on your workload; see the [benchmark and its methodology](#early-benchmarks-against-nextjs).

</details>

## Early benchmarks against Next.js

Dynamic streaming with 128 concurrent clients and a deterministic local backend delayed by 40 ms:

| Configuration | RAM | CPU load¹ | CPU/response | Throughput |
|---|---:|---:|---:|---:|
| Next.js | 605 MiB | 164% | 2.442 ms | 673 req/s |
| **Balanced** | **207 MiB** | 124% | 1.704 ms | 726 req/s |
| **Speed** | 496 MiB | 250% | **0.926 ms** | **2,698 req/s** |
| **Memory** | **179 MiB** | **75%** | 2.067 ms | 362 req/s |
| **Classic** | 303 MiB | 90% | 1.241 ms | 723 req/s |

<details>
<summary><strong>Benchmark methodology & trade-offs</strong></summary>

¹ 100% CPU = one fully utilized CPU core. RAM is measured under load.

Measured September 27, 2026, on Apple M4 against Next.js 15.5.12. Values are medians of three six-second runs using identical application sources. This table covers one streaming scenario, not an overall average or guaranteed gains. Functional parity was checked before benchmarking.

Under concurrent streaming, `memory` used 179 MiB versus 207 MiB for `balanced`, but served 362 versus 726 responses/s. On concurrent SSR, it used slightly more memory than `balanced`. The lowest-memory profile is workload-dependent.

</details>

## Guides

### Build adapters

Plain HTML/CSS/JavaScript sites need no package.json or React source tree:

```sh
prnext build ./my-site
prnext start ./my-site
```

An `index.html` at the project root is detected automatically. Explicitly select
it with `prnext build --adapter static --from .`. Root mode copies browser asset
extensions only; it omits dotfiles, npm metadata, JSON data, source/server folders,
configuration and server scripts. Put additional public data in a dedicated output
directory and import it with `--from`; do not put secrets in browser assets.

After running another builder, `prnext build --adapter auto` finds a completed
`dist`, `build`, `out` or `.output/public` directory. Multiple outputs require an
explicit `--from` choice. This command never runs another builder or its config.
Vite (including React, Vue, Svelte and Solid browser apps), Astro static output,
SvelteKit with `adapter-static`, and Nuxt generated output can use the same static
runtime. Keep each framework's server rendering and API routes out of the import.
See [Vite deployment](https://vite.dev/guide/static-deploy.html),
[Astro deployment](https://docs.astro.build/en/guides/deploy/),
[SvelteKit static generation](https://svelte.dev/docs/kit/adapter-static), and
[Nuxt deployment](https://nuxt.com/docs/4.x/getting-started/deployment).

PRNext keeps its React/Next-convention build as the default. The source candidate
also imports static browser builds produced by Vite or another framework:

```sh
npm run build
npx --no-install prnext build --adapter static --from dist --spa
npx --no-install prnext start
```

Use `--spa` only for client-side routing. Omit it for a multi-page site. PRNext
imports the completed public files; it does not compile Vue/Svelte source or run
another framework's SSR server. Static requests require no Node render worker.
This adapter needs the updated native binary built from the same source candidate;
it is not part of the previously published alpha package.

Every new build writes a versioned `build-output.json`. Inspect it with
`prnext output --json`. See the [adapter contract](packages/prnext/build/ADAPTERS.md)
and [compatibility scope](https://github.com/Lorkydey/PRNext/blob/main/COMPATIBILITY.md) for supported inputs and boundaries.

<details>
<summary><strong>Deploy to PRNext Cloud (local development)</strong></summary>

### Deploy to PRNext Cloud

The local CLI now supports browser login and source deployments. This feature is
not yet included in a published npm release or deployed to the public Cloud app.

```sh
prn login
prn deploy ./my-app
prn update ./my-app
prn whoami
prn logout
```

`prnext` accepts the same commands. Login opens the browser and reuses its session,
or returns to terminal approval after web sign-in. Confirm the code shown in your
terminal. `--no-browser` prints the URL for manual authorization.

`deploy` creates an upload project and saves its link in the ignored
`.prnext-cloud/project.json`; `update` sends changes to that same project.
`deploy --project ID` links an existing upload project. `--dry-run` lists source
files without connecting or uploading; `--no-wait` returns after queueing.
`--timeout SECONDS` controls waiting (default 600). After interruption or
`--no-wait`, `update` resumes the recorded request first; run it again to deploy
further changes. Server-side request IDs prevent duplicate queued builds.

Archives exclude `.env*`, credentials, `node_modules`, `.git`, generated
`.next`/`.prnext*` output and `.local`. Root `.gitignore` and `.prnextignore`
support additional glob exclusions and `!` rules; nested/global Git ignore files
are not read. Mandatory exclusions cannot be re-included. Nonexcluded symbolic
links are refused. On a compatible Host server: 100 MiB ZIP, 500 MiB expanded,
15,000 files and 64 MiB per file. Transfers use resumable 4 MiB chunks on the VPS;
legacy servers retain their 7 MiB upload limit. No object storage is required.

When production `.env` files are detected, `deploy` and `update` ask before
importing variables (default: no). `--with-env` explicitly opts in;
`--without-env` skips the prompt. Noninteractive commands skip import unless
`--with-env` is set. Variables travel through the encrypted environment API,
never inside the source ZIP or project link. Matching remote keys are replaced;
other keys remain. `NEXT_PUBLIC_` values may be exposed in the browser bundle.
This feature requires the updated Host API and remains unpublished.
Use project environment settings for secrets; inspect `--dry-run` for other
sensitive files in your own source tree.

Credentials stay under `~/.prnext/cloud/` (or private `PRNEXT_CLOUD_HOME`, outside
the source directory). Tokens are scoped to project reads/uploads/deployments,
expire after 30 days, and can be revoked with `logout` or in workspace settings.
Browser sign-out does not revoke authorized terminals.

For a local Cloud server, use `--server http://127.0.0.1:3003` or
`PRNEXT_CLOUD_URL`. From this checkout, run
`node packages/prnext/cli.mjs login --server http://127.0.0.1:3003`.
Production defaults to `https://app.prnext.dev`; credentials are isolated by origin.

A configured isolated Linux worker is required to deploy. A local Windows panel
supports login and dry runs, but reports unavailable hosting explicitly.
Approved offline dependencies, runtime network isolation and current Cloud quotas
still apply; these commands do not bypass the hosting worker or configure DNS/TLS.

</details>


<details>
<summary><strong>Check a migration before switching</strong></summary>

### Check a migration before switching

```sh
prnext migrate ./my-app --check
prnext migrate ./my-app --check --json
prnext migrate ./my-app --check --against http://localhost:3000 --candidate http://localhost:3001 --routes paths.json
```

The source audit reports unsupported Next imports with file and line numbers, client/server import conflicts, dependency versions and scripts requiring manual changes. It leaves sources, package files and builds untouched. Configuration files are evaluated by the existing preflight; installed dependencies and custom loaders still require a build. Warnings are distinct from blocking errors. A failed audit or response comparison exits with code 1.

For comparison, start the existing Next application and the PRNext candidate separately. `paths.json` is a JSON array such as `["/", "/products/123", "/api/catalog"]`; without it, the command selects non-parameterized page routes from the audit. It sends GET requests without authentication, follows no redirects, and compares status, content type, redirect destinations and bodies. JSON object key order is ignored; HTML compares text with scripts/styles removed. This verifies response samples, not hydration, styling, interactive behavior or every dynamic path. Timing observations are not controlled performance benchmarks. `--timeout 10000` sets each response's deadline in milliseconds.

</details>

<details>
<summary><strong>Inspect routes, cache and timings</strong></summary>

### Inspect routes, cache and timings

```sh
prnext build ./my-app
prnext start ./my-app --inspect
# In another terminal, after visiting the application:
prnext inspect ./my-app
prnext inspect ./my-app --json
prnext inspect ./my-app --otlp > metrics.json
```

The inspector explains static, dynamic and partially prerendered routes using build metadata, including observed App prerendering bailouts and Pages data hooks. Opt-in measurements show native HTTP timings, fetch destinations and timings, native data cache hits/misses/stale reads, bypass reasons and successful tag/path invalidations. A custom cache handler is identified as a delegation; its internal hit rate is not inferred. Native page-file cache decisions and client router caching are not counted as data-cache hits.

The summary adds sampled HTTP p50/p95, server errors, worker startup p95, current
worker queue/activity and recent Node worker RSS. Missing or stale resource samples
are shown as unavailable, never as zero. RSS excludes the native server; worker
threads sharing a PID are counted once. `start --inspect` also enables bounded native
counter snapshots. These opt-in diagnostics do not change normal serving defaults.

`inspect --otlp` writes an OTLP/JSON Metrics payload for a bounded local sample.
The custom `prnext.http.response.headers.duration` histogram uses seconds and stops
at response headers, excluding streaming body time. It is deliberately not named
`http.server.request.duration`. Samples can span sessions and overlap repeated
exports; this is a diagnostic snapshot, not a continuous traffic or billing counter.
No collector connection or public diagnostics endpoint is enabled automatically.

Timings end when headers are ready, so streaming body time is excluded. Samples are bounded, can span process sessions, and are written under the app's `.prnext-cache/inspect` directory. Request bodies, headers, cookies, URL queries and credentials are omitted; runtime tag/path identifiers are hashed consistently. Logs retain at most 1 MiB per segment plus a previous segment, with old process sessions pruned. Under load, diagnostics may drop samples. `--inspect` also works with `prnext dev`; standalone/native launches can set `PRNEXT_INSPECT_DIR` explicitly. No public diagnostic endpoint is added.

</details>

<details>
<summary><strong>Host several applications</strong></summary>

### Host several applications

```sh
npm run build -- examples/basic
npm run build -- examples/app
node packages/prnext/cli.mjs host examples/hosting/prnext.host.json --check
node packages/prnext/cli.mjs host examples/hosting/prnext.host.json
# In another terminal:
node packages/prnext/cli.mjs host examples/hosting/prnext.host.json --status
```

The example routes `basic.localhost:8080` and `app.localhost:8080` to separate applications. Resolve those hostnames to the listener address, or supply their exact `Host` header when testing. Installed packages use `prnext host config.json`. Configuration roots are relative to the JSON file. Each app has a unique name, root and exact hostname list, with optional `memoryMb`, `idleSeconds`, `workers`, `profile`, `env` and `inspect` settings. `--status --json` reads the local status snapshot beside the configuration, including its age; it does not connect to a live admin endpoint. Restart the host to apply configuration or build changes.

The native gateway keeps each application asleep until requested. A waking app reserves its configured memory budget; if capacity is full, inactive apps can release theirs, while busy requests receive 503 rather than starting an unbudgeted app. Requests and streaming responses hold their reservation until completion or cancellation. Idle apps begin stopping after `idleSeconds` and wake on the next request. Sleep and capacity eviction retain the memory reservation while the child drains supported `after()` and ISR work, allowing up to 300 seconds plus five seconds for process cleanup. A wake waiting for that capacity can take longer. Status shows `draining` with the process still present; monitoring and memory-budget enforcement continue. Global Host shutdown shortens outstanding retirement to its own 35-second deadline. Persistent caches remain on disk; in-process state and untracked background jobs do not survive sleep. Apps receive their configured environment and a small platform environment allowlist, then load their own `.env` files.

The watchdog samples the RSS of each app's native server and descendants about once per second. Exceeding `memoryMb` stops that process tree, can interrupt its in-flight requests, and imposes a 30-second cooldown. V8 also receives an initial heap guard unless the app config supplies `NODE_OPTIONS`. These are sampled operating budgets, not kernel-enforced hard limits; allow extra RAM for the gateway, the OS and sampling overshoot. Process separation isolates caches, environment and ordinary failures, but apps run as the same OS user: host only trusted applications. Use separate users or containers for untrusted tenants.

The 0.1.12-alpha Windows host check used four applications sharing one CPU and a 1 GiB Job commit budget. Two 30-second mixed SSR/stream/API trials measured about 333 requests/s through `host` versus 361 directly with the same V8 heap guard (about 8% gateway cost in this fixture). The matching direct controls followed the host trials; these short runs are not a general capacity guarantee. Three sleep/resume cycles per trial used `idleSeconds: 3` to exercise retirement: 32 simultaneous arrivals completed in 1.92–2.35 seconds, with one startup per application and no failures. The default whole-app deadline remains 300 seconds. The gateway keeps its one-second status/RSS monitor running while apps sleep; idle CPU is not zero. No host endurance or Linux performance result is claimed.

Hosting supports HTTP streaming and preserves the original application Host. HTTP/1 WebSockets tunnel to configured upstreams; other protocol upgrades are rejected. Put a TLS reverse proxy in front for public hosting; this command does not configure DNS, TLS, OS services or deploy to a VPS. Windows, macOS and Linux use the same JSON format and CLI.

</details>

<details>
<summary><strong>Keep production apps running</strong></summary>

### Keep production apps running

`prnext start` keeps its normal foreground behavior. Use the separate persistent commands when an app should survive closing the terminal:

```sh
prnext build ./my-app
prnext pstart ./my-app --name web --port 3000
prnext pstatus
prnext plogs web --follow
# After rebuilding the app:
prnext prestart web
prnext pstop web
```

`pstart` starts a detached supervisor and returns once the app passes its health check. Applications restart after a crash with increasing delays; ten failures within five minutes stop retries until `prestart`. A separate watchdog restarts the supervisor after a crash or an unresponsive event loop. Each app has a stable HTTP listener and its own native server and workers. This mode adds a shared Rust HTTP proxy and two supervisor processes; it does not enable the idle sleep or memory reservations of `prnext host`.

`prestart` copies the current production build, starts a replacement on a private port, and sends a GET to `--health-path` (default `/`). A 2xx or 3xx response must arrive within `--health-timeout 15000` milliseconds. Only then does new traffic switch to the replacement. If startup or the health check fails, the existing healthy instance keeps serving. Existing HTTP streams can finish for up to `--drain-timeout 30000` milliseconds, after which remaining requests are closed. Choose a health route that checks the dependencies your application needs. Two generations temporarily use memory and disk space during replacement.

Build copies live under the project's ignored `.prnext-persistent` directory and are removed after their processes stop. Rebuilding does not replace the active generation's compiled files. Project dependencies, `public` files and persistent caches remain shared; avoid changing dependencies or deleting public assets while old requests still need them. HTTP streaming, original Host headers and multiple cookies are preserved. HTTP/1 WebSockets tunnel to configured upstreams; other protocol upgrades are rejected. A supervisor crash can interrupt requests; health-checked replacement is not a guarantee against machine failures or incompatible application changes. A TLS reverse proxy can sit in front of the persistent listener.

Available commands:

| Command | Behavior |
| --- | --- |
| `prnext pstart [directory] --name NAME` | Start or restore an app; identical repeated starts are idempotent |
| `prnext prestart [name] [--all]` | Load the current build through a health-checked replacement |
| `prnext pstop [name] [--all]` | Stop apps and keep them stopped across supervisor restarts |
| `prnext pdelete [name] [--all]` | Stop apps and remove their saved configuration; retain logs |
| `prnext pstatus [name] [--json]` / `prnext plist` | Show status, PIDs, build IDs, starts and active requests |
| `prnext plogs [name] --lines 100 --follow` | Read/tail app output; `--supervisor` selects supervisor logs |
| `prnext pdown` | Stop the supervisor and apps, retaining enabled flags for their next launch |
| `prnext pstartup [--remove]` | Enable/remove automatic restoration at user login |

Without a name, `prestart`, `pstop`, `pdelete` and `plogs` select the app registered for the current directory. `pstart` accepts `--hostname`, `--port`, `--workers`, `--profile`, `--inspect`, `--health-path`, `--health-timeout` and `--drain-timeout`; see `prnext pstart --help`. Change saved listener/settings with `pdelete`, then `pstart`. Applications load their project `.env` files; arbitrary caller-shell variables and secrets are not copied into the saved registry. The state directory defaults to `~/.prnext/processes`; set `PRNEXT_PM_HOME` consistently for a separate supervisor. Keep that directory private: it contains local control credentials and application logs. Logs rotate at 10 MiB with three retained segments per app and for the supervisor. App output can contain whatever the application logs.

`pstartup` is opt-in and enables restoration on the **next user login**. On Windows it registers a hidden scheduled task for the current account; on macOS it writes a user LaunchAgent; on Linux it enables a systemd user service. These definitions restart a failed watchdog once managed by the OS. Windows and macOS user startup do not run before login. A Linux administrator can enable user lingering separately for boot-time operation without an interactive login. No OS startup settings change just by running `pstart`, and the command does not install a Windows system service or alter other accounts. Run `pstartup` again after moving or upgrading Node or the PRNext package. Platform references: [Windows scheduled tasks](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset), [Apple launch agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), [systemd user lingering](https://www.freedesktop.org/software/systemd/man/252/loginctl.html).

### Upgrade persistent apps

The supervisor may be shared by several projects. Use the same user and `PRNEXT_PM_HOME` throughout, and record the applications and their settings first:

```sh
npx --no-install prnext pstatus --json
```

Before changing package files, stop the apps and supervisor using the **old installation**. These commands affect **all apps managed by that supervisor**, so schedule the interruption accordingly:

```sh
npx --no-install prnext pstop --all
npx --no-install prnext pdown
```

Install the update and rebuild each affected project as described under [Install & upgrade](#install--upgrade). Using the new CLI, restart each app with its original name, port and other options. For example:

```sh
npx --no-install prnext pstart --name web --port 3000
```

If the saved Node or native executable path changed, remove that app's saved entry with `prnext pdelete NAME`, then register it again with `prnext pstart` and its recorded options. This removes saved settings but retains logs. If login startup was enabled, re-run `prnext pstartup` to refresh its paths.

`pdown` alone keeps apps enabled for restoration; stop them first to prevent an old configuration from restarting during the upgrade.

</details>

<details>
<summary><strong>Develop from this repository</strong></summary>

### Develop from this repository

Install Node.js 22+ and Rust with rustup, then run:

```sh
npm ci
npm run build:native
npm run dev -- examples/app
```

These commands also work in PowerShell and Command Prompt. On Windows, source builds require Visual Studio Build Tools with the Desktop development with C++ workload and a Windows SDK, plus NASM on x64. Rustup selects the repository's Rust 1.98 toolchain. Linux source builds need a C/C++ toolchain, NASM and pkg-config; macOS needs Xcode command line tools and NASM.

For production locally, run `npm run build -- examples/app`, then `npm run start -- examples/app`. Standalone output runs with `node server.js` on its build OS and architecture, including Windows. Published native packages remove the Rust/C++ build requirement for consumers. Keep the framework and platform components on matching release versions.

For source builds, `cargo build --release --locked --features gzip-zlib-rs` enables an experimental alternative gzip/deflate backend. Ubuntu x64 trials reduced JSON API CPU cost but increased cumulative streaming RSS, so this option is disabled by default. It also changes the Rust PNG/TIFF codecs; runtime profiles and Node heap settings remain unchanged. Compare CPU, response size and memory on your workload before choosing it.

</details>

## Contributing

Read the [contribution guide](https://github.com/Lorkydey/PRNext/blob/main/CONTRIBUTING.md),
[Code of Conduct](https://github.com/Lorkydey/PRNext/blob/main/CODE_OF_CONDUCT.md)
and [security policy](https://github.com/Lorkydey/PRNext/blob/main/SECURITY.md).

<details>
<summary><strong>License & credits</strong></summary>

### License and credits

PRNext is licensed under the [MIT License](LICENSE), copyright © 2026 Thomas (Lorkydey). Commercial use, modification, and redistribution are permitted; keep the copyright and license notice when distributing copies or substantial portions of the software. Third-party components retain their own licenses.

If PRNext helps your project, a credit such as **“PRNext by Thomas (Lorkydey)”** with a link to [prnext.dev](https://prnext.dev) would be appreciated. A public credit is optional, not an additional license condition.

</details>
