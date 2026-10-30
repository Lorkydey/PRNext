# Changelog

## 0.1.18-alpha - release candidate, 2026-10-29

This candidate is not yet published to npm. The current published release remains
0.1.17-alpha; the changes below describe the new source and require matching
0.1.18-alpha native packages. Next.js compatibility remains partial.

- Create a minimal TypeScript App Router application with `prnext create`,
  including scripts, aligned React dependencies and an installed AI guide
  reference. Support JavaScript and preparation without dependency installation;
  refuse existing nonempty directories and preserve workspace package managers.
  Recognize macOS system directory aliases while rejecting user-created links
  and junctions in the project path. Accept Windows DOS directory aliases only
  after checking stable physical directory identities.
- Scope production styles to the routes that need them, retain eligible immutable
  assets across bounded deployment generations and validate deployment identity
  on navigation. Reuse validated compilation work without caching private output.
- Add fair per-route admission, bounded render queues and response buffers,
  quota-aware CPU/memory profiles and coordinated prerender finalization.
  Drain tracked post-response work before retiring workers and bound recovery
  without replaying requests that may already have produced side effects.
- Support opt-in `htmlOnly` output for fully static, noninteractive Node App
  routes. Preserve CSS, fonts and metadata without a client bootstrap or Flight
  payload; reject incompatible rendering features rather than silently dropping
  application behavior.
- Reconcile coalesced filesystem notifications to discover new nested source
  directories, preserve explicit watch refreshes and wait for actual interactivity
  in lazy-routing checks. Restore metadata-helper resolution and native TypeScript
  diagnostic refresh after source or configuration changes.

- Compile cold development destinations after middleware and rewrites without
  replaying the request. Materialize retained parallel branches together and
  keep unrelated routes cold; preserve the complete-graph safe mode.
- Compact production CSS Module class and animation names while preserving
  globals and composition. Shorten internal webpack exports and reuse shared
  chunks without rewriting public interfaces, source maps or asset hashes.
- Negotiate streaming differential Flight for App navigation GETs. Reconstruct
  exact fresh output from bounded, credential-bound bases; fall back to full
  Flight for misses and retry an invalid delta once without replaying actions.
- Support `instrumentation` registration and request-error hooks in Node, RSC
  and Edge. Add optional correlated native HTTP, Node, RSC and fetch traces via
  bounded OTLP HTTP JSON export and application OpenTelemetry context.

- Retain inactive App Router branches with React Activity, one bounded layout
  budget, paused effects, fresh history authorization and restored focus/scroll.
  Purge inactive state on mutations, refresh and observed authorization changes.
- Add opt-in partial navigation stages, `navigation()` and `prefetch()` gates,
  inherited `ensureStatic` requirements and full static navigation validation.
  Preserve static prerendering through stage gates and isolate private previews.
- Store eligible JavaScript compilation graphs as binary metadata and shared,
  content-addressed blobs. Compress large outputs selectively, verify checksums
  and treat corrupt, missing or concurrently evicted entries as ordinary misses.
- Extend first-party Redis storage to native HTML/ISR, fetch and `unstable_cache`
  through `createRedisIncrementalCache`. Fence the entire regeneration with a
  shared lease, recheck after admission and preserve binary RSC/Map values.

- Support application-installed TypeScript 7 through its official native CLI for
  build checks, typecheck, typed routes and development diagnostics. Preserve the
  TypeScript 5/6 compiler API path and keep native incremental state temporary.
- Recover App navigation GETs after bounded transport failures while retaining
  mounted state. Cancel superseded requests, expose optional `useOffline` state
  and never automatically replay Server Actions or other POSTs.
- Add an optional Redis Cache Components handler with a minimal node-redis
  client, cross-process fill leases, binary values and atomic tag generations.
  Fence invalidated or expired producers and validate relocated standalone
  output. Storage roles are explicit; no backend is replaced automatically.
- Decode buffered HTML incrementally without a second aggregate binary copy.
  Offer `PRNEXT_SSR_STREAM=node` for workload comparisons; retain the default Web
  renderer and the original APIs for partial/PPR continuations.
- Wait for bounded static-render `after()` and cache settlement before returning
  a completed prerender path, so build-worker shutdown cannot discard that work.
- Prioritize actual navigation and intent-driven prefetching over viewport scans
  in both routers. Bound speculative concurrency and queues, honor data saver,
  connection and visibility changes, and preserve cancellation and private-data
  validation. Add keyboard intent and honor Link opt-outs on hover and focus.
- Report official React Compiler decisions with function names, skip reasons,
  graph coverage and cached-transform reuse through `prnext compiler [--json]`.
  Publish diagnostics with the successful build, outside public assets, and
  distinguish disabled compilation from unobserved or skipped functions.
- Include awaited hydration imports and SSR-used dynamic chunks in initial-JS
  analysis. Add per-path samples, compression-specific maxima and explicit
  incomplete coverage; reject misleading budgets and legacy baseline comparisons.
  Prune optional partial-rendering browser code when Cache Components is disabled.
- Add opt-in support for the official React Compiler through `reactCompiler: true`
  or a validated options object. Compile browser application components and
  isolated App Client Component server rendering, preserving development source
  locations and Fast Refresh. Support annotation mode and per-function opt-outs;
  keep Pages server rendering, framework, server-only and dependency graphs
  outside the transform.

## 0.1.17-alpha - performance and development, 2026-10-26

- Resolve macOS root aliases and Windows short paths consistently while preserving
  development-generation containment and linked-checkout identity checks.
- Avoid retaining recently modified built files in the native byte cache when
  filesystem timestamps cannot distinguish consecutive writes.
- Keep runtime and hydration diagnostics across unrelated type-only development
  generations; clear them when the affected browser code or navigation changes.
- Refresh background TypeScript diagnostics on macOS even when native source-file
  notifications are lost. Use adaptive polling for application files, preserving
  explicit watch settings and native dependency watchers.
- Let Escape close the console when focus is outside a hovered tooltip, while
  retaining tooltip-first dismissal inside native preview dialogs.

- Ship a short `AI.md` index and six version-specific guides in the npm package.
  Add `prnext docs --ai` with topic, catalogue and JSON output, without requiring
  a native executable, project configuration or network access. Explicit
  `prnext docs --ai --init` adds an idempotent reference to the application's
  `AGENTS.md`, preserving existing instructions; installation never edits it.
- Keep loader cache failures optional, validate stored metadata and publish
  cache entries atomically; preserve genuine loader failures and the cache opt-out.
- Add fixed SSR stage/outcome diagnostics and resource-budget occupancy to inspect.
  Add configurable queue waits and an optional absolute HTTP response deadline,
  with cancellation-safe stream cleanup and independent tracked after-response work.
- Retain bounded incremental development Webpack compilers, invalidate changed
  configuration/environment/plugins, and dispose them on compiler shutdown.
- Rebuild only affected CSS bundles and preserve unrelated stylesheet URLs.
  Track added/removed imports and fall back when CSS Module exports change.
- Transfer large HMR graphs as compact bounded transactions; commit complete
  indexes atomically and traverse cyclic/deep dependencies in Rust. Capacity
  failures explicitly fall back to complete refreshes.
- Extend check with Node/native/TypeScript diagnostics, and add standalone
  typegen/typecheck commands that report generated/configuration updates.
- Respect npm/pnpm/Yarn workspace installation roots and lockfiles in migration;
  protect unrelated manifests and restore saved metadata on safe rollback.
- Add explicit analysis baselines, raw/gzip/Brotli selection, per-route size and
  regression budgets, and deterministic failure status for invalid inputs.

- Reject React server/client directives in unsupported `.mts`/`.cts` modules
  before activating a build. Previously, those files could bypass framework
  transforms and include server implementations in browser assets. Ordinary
  TypeScript helpers remain supported; use `.ts`/`.tsx` for framework boundaries.

- Add `prnext dev --safe` and readable rebuild reasons. Preserve state for
  anonymous default JSX components and avoid unnecessary reloads when generated
  Server Action references rotate between development builds.
- Update Tokio to 1.53.3 and the development lockfile to fast-uri 3.1.9.
  Extend exact-archive lifecycle validation to Node 22, 24 and 26 and verify
  global CLI installation in an isolated prefix. See the
  [release preparation checks](tests/performance/PREFLIGHT-0.1.17.md).

- Index development route/module dependencies in Rust. Reevaluate affected
  refresh boundaries, leave unrelated browser models alone and defer edits to
  unopened routes. Unknown/custom graphs retain complete invalidation.
- Publish CSS-only generations without compiling JavaScript or restarting the
  application worker. Retain immutable assets and React state; changes to CSS
  Module exports, Sass or custom processors fall back to the complete compiler.
- Prewarm isolated development workers while compilation runs, with native
  process supervision, authenticated generation handoff and bounded draining.
  Fall back to ordinary worker startup when warmup is unavailable.
- Load console, device-preview and inspector interfaces on demand, preserving
  immediate console capture and synchronous popup reservations.
- Prerender independent production routes with a bounded worker set. Preserve
  error-page ordering, validation, request isolation and deterministic output.
- Reuse validated precompressed asset sizes in bundle analysis, avoiding a
  second gzip/Brotli pass while keeping standalone analysis accurate.
- Recycle the development compiler based on measured memory pressure, sustained
  growth and a session limit instead of restarting every 24 builds.
- Add opt-in two-tab development endurance checks, memory/retention budgets and
  a manual performance workflow with comparable-machine regression gates. See
  [development optimization validation](tests/performance/DEV-OPTIMIZATIONS-0.1.17.md).

- Disable TCP's small-packet delay on accepted Rust HTTP connections, including
  development and private routing/cache listeners. Preserve streaming and drain
  semantics; the existing persistent proxy already enables TCP_NODELAY.
- Index the bounded gzip/Brotli build cache once per build instead of rescanning
  it after every publication. Serialize duplicate cache writes and eviction;
  validate decoded bytes on reuse and keep cache failures optional.
- Avoid redundant App graph passes when RSC discoveries are already consumed by
  SSR/browser compilation. Retain convergence for late Server Actions, client
  boundaries, edge/native dependencies and CSS. See the measured
  [0.1.17 optimization results](tests/performance/OPTIMIZATIONS-0.1.17.md).

- Gather the red issue indicator into a short stroke along the left of the
  developer controls, then draw the View issues outline in place. Reverse on
  close while preserving interruptions, severity and instant reduced-motion
  states in every logo corner.
- List current development errors above the selected diagnostic, with Copy for AI
  and Send to AI in the header. Preserve complete messages, mapped source, editor
  actions and collapsible stack traces in a compact dark dialog.
- Surface recoverable hydration errors and attribute mismatches as non-blocking
  issues without automatically opening an overlay; keep details in View issues.
- Distinguish non-blocking TypeScript issues with two red logo arcs from critical
  build or runtime errors with a full red ring. Preserve the blue compilation
  loader and respect reduced-motion settings. Keep the logo free of numeric badges.
- Unify device and preview-action tooltips with current viewport dimensions,
  keyboard focus, Escape dismissal and positioning that avoids modal clipping.
  Keep detached tools at the correct CSS viewport width on mobile browsers.
- Select components before connecting an assistant, then use a compact connection
  dialog without inspector headers or tabs. Detect initialized MCP sessions, keep
  idle sessions alive, collapse setup after connection and preserve drafts while
  reconnecting. Reject disconnected context submissions.
- Animate client configuration and setup help, keep a 3.5-line scrollable preview
  beside the full-copy button, and provide client-specific MCP setup instructions.
- Refine phone, tablet and desktop frames with a single screen clip and slimmer
  bezels. Hide mobile-preview scrollbars while preserving actual scrolling and
  restore the original scrollbar styles in desktop mode.
- Rotate the entire device with an interruptible quarter turn, keeping its
  diagonal inside the canvas and preserving the live preview's state.
- Refine component selection with a smoothly retargeting dashed frame, square
  handles, dimensions and file-type icons beside anchored filename/line labels.
  Use pointer speed and a short pause to infer hover intent, avoiding fast passes
  and brief visits to small nested elements; keep clicks and keyboard immediate.
  Keep a compact keyboard/touch toolbar. Add branded AI client setup and a focused
  selected-element composer; preserve typed instructions during async capture.
- Add local MCP development tools and an opt-in outbound relay for existing Host
  MCP connections. Preserve workspace/project permissions and revocation, keep
  localhost capabilities private, and deliver selected screenshots as MCP images.
- Verify corrections against a newer build actually committed in an open browser;
  distinguish failed and inconclusive results from verified observations.
- Map runtime errors to original source and editor links. Select DOM elements to
  queue source, style and screenshot context for an assistant.
- Add a compact inspector for real requests, measured build/refresh performance,
  searchable routes and targeted native cache invalidation. Preserve unrelated
  cached routes and compiler entries; disclose cold/custom-handler limitations.
- Combine bounded browser and server logs with source/level filters and AI copy
  actions. Preserve native console behavior and exclude request headers/bodies.
- Repair exact-source-revert Fast Refresh, App refresh readiness and recovery from
  failed initial application imports without repeated reloads.
- Remove the heavy outer preview borders while keeping optional device frames.
- Drag the developer logo to any corner with animated snapping, touch/pointer
  capture, keyboard movement and tab-local persistence. Simplify previews with
  centered device frames, an optional frame toggle and neutral black surfaces.
- Refine the dev indicator with a neutral near-black finish and a single bubble
  contour attached to its logo. Reveal it from the logo with interruptible motion,
  a shorter close transition and an immediate reduced-motion alternative. Keep
  actions directly visible without a header and use contained keyboard focus.
- Keep the preview reload control in its toolbar so it cannot cover the embedded
  application's controls or error-overlay dismissal button.
- Add a compact, development-only PRNext indicator at the bottom-left with live
  build/connection feedback, issue recovery and
  reload/hide controls; support configurable corners and `devIndicators: false`
  while preserving errors and Fast Refresh.
- Add phone/tablet viewport previews with rotation and an original-page Desktop
  mode. Use actual iframe viewport sizes for CSS media queries; retain independent
  preview state across size changes and Fast Refresh, without nested indicators.
- Add a development client console with level/search filters, pause, clear and
  copy. Capture native messages and unhandled client errors in a bounded 500-entry
  in-memory buffer; keep native console output and separate page/preview contexts.
- Add pop-out icons for client console and device previews, live console windows,
  dock controls and popup-blocking feedback. Preserve console filters and preview
  dimensions/orientation/URL; clean up tool windows when their source closes.
- Refine device previews with compact icon controls, width tooltips, a centered canvas
  and a draggable/keyboard width handle. Desktop fills the canvas; Close returns
  to the original page. Retain custom width when popping out or docking.
- Add expandable console messages with complete captured-text copying and Copy
  for AI actions. The errors action includes all retained errors regardless of
  filters/pause, groups duplicates and preserves stacks. Keep longer messages
  within bounded per-message and total text budgets; label truncation explicitly.
- Compile development routes when requested, retaining open browser routes and
  bounded inactive entries. Keep complete graphs for middleware, rewrites and
  parallel/intercepting routing. Retain shared/error infrastructure.
- Keep one Rust development listener and SSE stream across edits. Activate
  immutable render generations after readiness, drain previous responses and
  retain recent assets. Preserve compatible React state and recover failed edits.
- Persist development transforms separately from production and enable a bounded
  compiler V8 cache. Watch source directories on Windows to prevent cache writes
  flooding recursive filesystem notifications.
- Use Rust-based Lightning CSS for default CSS processing with Browserslist
  targets; preserve custom PostCSS/Tailwind, Sass and CSS Modules pipelines.
- Report TypeScript diagnostics through a background incremental watcher without
  blocking development responses or emitting application JavaScript.
- Add opt-in typed route generation, Link/router suggestions and the `route()`
  helper with encoded dynamic parameters. Preserve JSONC and inherited tsconfig
  roots while including generated declarations.
- Render Pages data on request in development; retain data/fallback validation,
  skip offline HTML/compression and coalesce rapid source edits.
- Add incremental production sessions (`build --watch` and `createBuilder`).
  Retain bounded esbuild graphs while isolating prerender execution per build;
  source/dependency changes still rebuild and action keys remain fresh.
- Share Rust/Oxc read-only source analysis across route configuration, metadata
  exports and npm import discovery. Keep Babel for binding-aware transformations.
- Add `prnext analyze` with per-route reachable browser JavaScript, compressed
  sizes, largest modules, previous-build deltas and optional JavaScript budgets.
- Add opt-in, budgeted Node/RSC module preloading through `workerPreload`.
  Imports execute module initialization, never page renders or request handlers.
- Monitor persistent replacements after switching traffic. Retain the previous
  instance for a configurable rollback window and restore it after a crash or
  three consecutive failed health probes, if it remains healthy.
- Tunnel HTTP/1 WebSockets through the Rust persistent proxy, native external
  rewrites and multi-app host. Preserve handshakes, backpressure and lifetime
  accounting; persistent generation drains can cancel remaining tunnels.
- Persist pure build transformations and prepared shared runtime bundles across
  build processes. Content, compiler, configuration, dependency and environment
  changes invalidate the relevant entries; corrupt records are recomputed.
- Enable a bounded, project-local Node/V8 compilation cache for both socket and
  stdio workers. Flush newly compiled modules while workers remain online;
  application state, responses and Server Action keys are never reused.
- Move the persistent `pstart` HTTP data plane into a shared Rust process.
  Preserve health-checked switching, streaming, cookies, backpressure and bounded
  generation draining. Keep lifecycle commands, log rotation and recovery in the
  existing supervisor. A forced drain aborts incomplete response bodies.
- Index dynamic routes in Rust while retaining route precedence, catch-all
  behavior and parameter decoding. Bound trie depth for unusually long routes.
- Generate and reuse validated Brotli sidecars alongside gzip for immutable
  build assets. Negotiate encodings natively, preserving HEAD, ranges, cache
  validators, containment and sidecar freshness checks. Dynamic compression
  remains gzip; this does not introduce dynamic response caching.

Published on npm with all six matching native packages. Both `latest` and `alpha`
select `0.1.17-alpha`; install this experimental alpha with
`npm i @thomas.f/prnext`. Exact archives passed installation and lifecycle checks
on all six targets with Node 22.23.4, 24.22.1 and 26.12.1, and the final source
passed the required Windows, Linux and macOS CI before merge. After updating,
rebuild applications and replace their deployed runtime or standalone output;
existing builds do not acquire the new runtime by updating the CLI alone.
See [RELEASE.md](RELEASE.md) for verification and upgrade requirements.

## 0.1.16-alpha - React Server Components security update, 2026-10-22

- Require the aligned React, React DOM and react-server-dom-webpack 19.3.1 family
  for the October 14 upstream RCE and Server Functions denial-of-service fixes
  (GHSA-xqc2-xf4c-x3h3 and GHSA-h3gv-c5rc-p453).
- Update installation instructions, workspace examples and the lockfile. Existing
  App Router dependency validation rejects 19.3.0, including a mixed installation
  that updates React but leaves the vulnerable RSC decoder behind.
- Add a release security floor independent of npm audit's advisory coverage.

Update all three React peers and rebuild applications before deployment. Updating
Node alone does not fix these React advisories. GitHub and npm release availability
are tracked separately in RELEASE.md and the release notes.

## 0.1.15-alpha - security updates, 2026-10-21

- Update rustls to 0.23.46, rustls-webpki to 0.103.16 and webpki-root-certs
  to 1.0.10, including the distrusted emSign intermediate certificate fix.
- Update sharp to 0.35.5 and source-map-js to 1.2.2 in the dependency lock.
  Rebuild the shipped OG renderer and fall back to resvg when an optional native
  sharp backend has missing or older-than-2.63.2 librsvg.
- Require patched Node.js 22.23.4, 24.22.1 or 26.12.1 release lines. Node and
  deployed container images must be updated separately from this package.

This source prerelease does not publish npm packages. The public npm alpha
remains 0.1.13-alpha until exact new native/main archives are validated and published.

## 0.1.14-alpha — GitHub source prerelease, 2026-10-21

- Protect React builds and static imports with one cross-process project lock.
  Recover dead local owners conservatively; never expire active builds by age.
- Precompress static output with bounded gzip workers and validate supplied sidecars.
  Failed imports preserve the previously published build.
- Extend opt-in inspection with sampled p50/p95 headers latency, server errors,
  worker startup/RSS/queue readings and an OTLP/JSON histogram. Missing readings
  remain unavailable, and no public diagnostics endpoint or collector is enabled.
- Preserve main-branch fixes for project-contained credential aliases, port-zero
  image callbacks, stdio RSC settlement and browser prefetch observation.


- Add the versioned build-output contract and a static adapter for completed
  browser builds, including Vite output and explicit HTML-only SPA fallback.
- Validate static artifacts natively and serve them without React render workers.
  Existing React builds and legacy lifecycle validation remain supported.
- Fix native image callbacks when listening on a dynamically assigned port.
- Preserve dual-format client dependency boundaries and route work deadlines.
- Include the reviewed OG renderer security follow-up described below.

This source prerelease requires freshly built binaries for every supported
platform before npm publication. The published npm alpha remains 0.1.13-alpha;
GitHub releases and CI artifact verification do not publish npm packages.

## Unreleased — security follow-up, 2026-10-16

- Package the reviewed ImageResponse renderer with fflate 0.7.5 instead of
  installing `@vercel/og` and its vulnerable fflate 0.7.3 dependency. Replace the
  copy embedded in the upstream bundle as well; a workspace override alone does
  not fix consumer installations. Default TTF and compressed WOFF rendering are
  covered by regression tests. Font/WASM assets and upstream licenses are shipped.
- This changes local source and future archives. The already published
  0.1.13-alpha package is immutable and has not been replaced.

## 0.1.13-alpha — prepared 2026-10-12

### Fixed

- Native shutdown owns and joins worker tasks, post-response work and detached Pages regeneration before dropping private cache/routing services. HTTP and background work share a 30-second standalone shutdown deadline; forced cleanup retains child ownership until reaping. Host shutdown cancels queued starts and drains applications concurrently under its 35-second bound.
- Ordinary Host sleep/capacity eviction allows up to 300 seconds of tracked work plus process cleanup instead of killing the application after three seconds, retaining its memory reservation until exit. Status and memory enforcement continue during retirement; cancellation of an incoming wake does not cancel the old application's drain. Global shutdown and memory violations can shorten an existing retirement. Stdio worker retirement also drains post-response finalizers. `after()` remains limited to Node Route Handlers and Server Actions; cache invalidation inside its callbacks, RSC and Edge lifecycles remain unsupported explicitly.

- Production builds group runtime ESM modules into shared chunks to reduce worker startup loading, preserving worker entry paths, deferred imports and shared request context. The HTTP adapter avoids initializing Node's unused WebSocket implementation during import. Worker retirement, profile limits and dynamic response freshness are unchanged; rebuild applications to use the grouped runtime.
- Production App Router routing scaffolds now reuse immutable ancestor chains, route scores and slot ordering. The destination pathname is decoded once per request, segment handling avoids repeated parsing and temporary arrays, and instant-validation work runs only when requested. Component exports and configuration remain live; parameters are always request-owned. Development, older/mutable routing trees and unsupported custom scaffolds retain the compatible live traversal. Rebuild production applications to enable the compiled routing plans.
- Local rendering/routing candidate (October 15): fragmented inline HTML elements are scanned incrementally with bounded fragment bookkeeping, and quoted attributes skip directly to their closing quote. App Router pattern parsing is cached with bounded/weak ownership; saved parallel-route selection decodes each path once and preserves route precedence in one pass. Dynamic response bodies and request parameters are not cached.
- Local performance candidate (October 15): streamed Flight responses use React's native Web-stream decoder when available, avoiding an extra Node stream adapter. Production client-module manifests are explicitly sealed so unchanged SSR mappings no longer require a full scan on every response. Mutable/development manifests and build-directory changes retain validation; this does not cache dynamic page output.
- Compatibility candidate (October 14): App convention files honor `pageExtensions` priority; identical public/App metadata assets no longer block builds. `devIndicators: false`, pure-barrel `experimental.optimizePackageImports`, App Router `maxDuration` (1–300 seconds), and bounded `proxyClientMaxBodySize` configuration are implemented.
- Proxy request clones preserve the upstream complete-chunk overflow behavior; binary Rust/Node ingress supports requests up to 32 MiB. Server Action ingress retains its separate 8 MiB maximum.
- Node Route Handler and Server Action `after()` callbacks run after successful, failed or disconnected HTTP responses. Actions acknowledge actual HTTP completion separately from intermediate Flight rendering. Their request context and tracked worker lifetime are retained while the transport lane becomes reusable. Server Component and Edge `after()` lifecycles remain unsupported explicitly.
- Optional `require()` calls inside `try/catch` retain their package fallback instead of becoming fatal plugin-resolution errors. PostgreSQL's `pg` remains external by default, preserving lazy access to `pg-native`.
- Node Route Handlers compile separately from RSC pages so shared `use server` helpers remain directly callable. Mixed npm exports such as server-renderable Markdown plus unused hook-based components preserve React's real server singleton without failing native ESM linking on absent client hooks.
- Bounded, hash-checked project-local Google font input caching supports offline builds after the inputs have been fetched. No dynamic response cache is introduced.

- Linux production launches can replace the otherwise idle Node launcher with the Rust server using guarded `process.execve`; incompatible Node flags/preloads retain the existing launcher path. Linux workers terminate when their Rust parent dies, and Unix SIGHUP uses graceful shutdown.
- Completed or cancelled RSC requests release obsolete response, channel and deadline references while legitimate background cache work and its watchdogs remain supervised.
- Streaming API and middleware responses reuse their inactivity timer. Immediately ready producers yield after bounded batches, including empty chunks, so network events and cancellation timers can run. Empty chunks do not extend the inactivity deadline; transport framing and backpressure remain enforced.

### Measurements and tradeoffs

- October 15 frozen-candidate comparison: on Linux x64, `balanced` SSR/streaming/JSON throughput was 217.70/437.43/1415.93 req/s versus Next.js 16.4.1 at 157.77/277.30/1050.33. Cumulative server RSS was 149.39/163.49/126.29 MiB versus 246.58/251.27/224.69. Windows SSR improved, streaming was approximately tied and JSON was 4.5% slower than Next. TanStack Start remained faster on these App-style dynamic fixtures. These are five 30-second production runs per scenario on one server CPU, without a dynamic page cache; they precede the final shutdown fix. See [conditions, versions and limitations](RELEASE.md#performance-evidence).
- The direct Route Handler adapter change improved median JSON throughput by 6.37% on Windows and 7.95% on Linux in separate three-run comparisons; Linux RSS increased from 121.99 to 124.18 MiB. It avoids constructing unused Pages request objects; it does not cache responses. The global HTTP TCP_NODELAY experiment was rejected because its JSON CPU/throughput regression outweighed the gzip benefit.

- October 15 local wake comparison, twelve paired cycles on one logical CPU (Windows x64, Node 24.15.0): median complete dynamic response after worker retirement fell from 356.6 to 327.7 ms, with 7.0% less CPU per wake. Retired server RSS remained about 17.3 MiB. A separate three-by-20-second mixed-load comparison measured 1.2% lower throughput, 0.9% more CPU per response and 2.8% higher RSS; 50,366 measured responses had no errors. These are comparisons against the frozen local candidate, not Next.js or published npm releases. The earlier isolated 383 ms observation is not the paired baseline.
- The October 12 Ubuntu VPS comparison used the previous local candidate and the final local candidate, not published npm versions or Next.js. Its 222,443 timed responses and separate 129,932 mixed-load responses had no errors. Preheating errors fell from 21 to zero; a separate cold/prewarmed stream diagnostic reproduced 12 errors before the fix and zero afterward.
- `balanced` SSR/streaming CPU and RSS changes were small, with no large default memory reduction demonstrated in that final comparison. The streaming API fixture improved p95 from about 543 ms to 410 ms, with 5.4% lower throughput and 5.7% more CPU per response. These short repeated trials on a shared, CPU-limited VPS are not universal capacity claims.
- After 15 minutes of inactivity, the final balanced candidate used about 19.4 MiB cumulative server RSS. The cgroup CPU counter did not advance during the final ten minutes; the first response took about 0.98 seconds. No idle bug was reproduced, and the distinct profile admission, V8 and retirement defaults remain unchanged.
- `gzip-zlib-rs` is an opt-in Cargo feature for source builds. In separate trials it reduced JSON API CPU per response by about 18.4%, but increased streaming server RSS by about 11.4%. Default npm binaries retain the existing gzip backend and level; the feature also affects image codecs using `flate2`.
- The October 12 source candidate passed Node 22/24 and Rust checks, Windows targeted integration checks, and Linux checks on the isolated VPS. Those checks precede the subsequent compatibility and routing changes. The final versioned npm archives still require the six-platform package workflow and Linux release checks described in [RELEASE.md](RELEASE.md). Four-minute mixed-load runs per candidate and idle/resume cycles are not an hours-long endurance test.

### Upgrade and remaining limits

Install matching framework/native versions, rebuild each application with `prnext build`, then restart or redeploy the full standalone output. Next.js compatibility remains partial. The experimental 1 GiB density regression and hosting limitations documented for 0.1.12-alpha remain; this release does not claim to fix them. This entry describes release preparation, not completed npm publication.

## 0.1.12-alpha — prepared 2026-10-11

### Fixed

- Client disconnections no longer automatically restart a healthy shared Node render host. Incomplete transport lanes are discarded; fully validated terminal frames allow safe reuse. Cancellation admission, deadlines and background work remain bounded and tracked.
- Worker retirement waits for real inactivity and tracked finalization. Dynamic builds carry a fingerprinted lifecycle contract, rejected early when missing, incompatible or mixed.
- Filesystem admission bounds live file responses, queued callers and submitted helper tasks. Overload returns explicit noncacheable 503 responses with `Retry-After`; cancellation releases queued work and running OS work retains its permit until completion.
- Pages data requests preserve filesystem overload as 503 instead of attempting a 500 error render. Proxy-generated overload and transport errors now also use `Cache-Control: no-store`.
- Clean `npm ci` has complete native optional dependency lock entries. Framework, native descriptors, Cargo and workspace versions are synchronized.
- `reactCompiler: false`, `typedRoutes: false` and explicit TypeScript checking options are accepted. Unsupported enabled compiler/typed-route features fail with actionable diagnostics rather than being ignored.

### Tradeoffs and known limits

- Defaults remain `balanced` for `start` and `memory` for `host`. Idle retirement reduces retained memory and adds startup latency to the next response. Host sleep stops the whole application, including in-process background work; it is separate from worker retirement.
- The V6 static admission bounds fix uncontrolled queue growth; they do not imply higher peak throughput. The prior Windows small-gzip comparison measured a roughly 3.9% lower median throughput with overlapping ranges and host-load limitations.
- Eight independent apps on one CPU with a Windows Job **commit** limit of 1 GiB and experimental `balanced` plus `NODE_OPTIONS=--max-semi-space-size=1` still have a known allocation-failure regression: V6 failed 2/5 original trials versus V5 0/5, and 1/3 new trials versus V5 0/3. The instrumented follow-up found no retained filesystem queue/permits after drain. The fine cause remains unidentified; **not fixed**. Do not use this experiment as a supported density target. `balanced-small` is not a built-in profile.
- Next.js compatibility remains partial. TypeScript checks require an explicit `typescript` option and the app's installed TypeScript; generated route types, React Compiler and the Next.js language-service plugin remain unsupported.
- Ubuntu 24.10 x64 validation passed installation, application builds, 122 targeted integration tests, the three-app `host` scenario and both isolated npm installation layouts. The Linux binary was cross-compiled on Windows and executed on Ubuntu. macOS and ARM64 validation remains pending; verify each native archive on its target platform before publication.
- Host budgets sample per-app RSS; they are not hard kernel limits. WebSocket upgrades are unsupported. A request racing an app crash can return 502; subsequent requests receive 503 during the five-second crash cooldown. The proxy does not replay requests.

### Upgrade

Install the matching framework/native release, then run `prnext build <project>` and restart each application. Rebuild standalone deployments on their target OS/architecture and redeploy the whole output. Old dynamic artifacts without the new runtime contract are deliberately rejected; copying only the native executable or a contract file is insufficient. A legacy build containing only static files remains usable without Node.

See [RELEASE.md](RELEASE.md) for checks, native archive collection and ordered publication commands. This working tree prepares the release; it does not publish it.

## 0.1.1-alpha — 2026-10-08

**README update:** `0.1.11-alpha` updates the README documentation only, with no runtime behavior changes.

### Added

- Native Windows x64 and ARM64 packages, alongside macOS and Linux glibc support.
- Persistent app management with `prnext pstart`, health-checked replacements, crash recovery, rotating logs and optional restoration at user login.
- `prnext migrate --check` for source compatibility audits and optional GET response comparisons between an existing app and a PRNext candidate.
- `prnext inspect` and opt-in `--inspect` diagnostics for route rendering, cache decisions and request timings.
- `prnext host` for hostname-based multi-app hosting, with on-demand startup, idle sleep and sampled memory budgets.

### Fixed

- Standalone dependency tracing across Windows drives, scoped packages and workspace path aliases.
- Development child-process shutdown and file replacement on Windows.
- Cold-worker connection bursts that could exceed small operating-system listen backlogs, including on macOS.
- Windows npm packaging and generated migration scripts. Scripts now use the portable `prnext` command; `prn` remains available in compatible shells.

### Alpha limitations

Next.js compatibility remains partial; this release is for experimentation and feedback. Migration comparisons check response samples, not browser behavior or complete functional parity. Inspector timings stop at response headers. Hosting memory budgets are sampled, not hard limits, and host/persistent proxies do not support WebSocket upgrades. No new performance benchmark results are claimed for this release.
