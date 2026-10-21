# Changelog

- Reliability candidate: exclusive cross-process React/static build publication,
  dead-local-owner lock recovery, validated static gzip precompression, readable
  sampled diagnostics and opt-in OTLP/JSON headers-timing export. Native runtime
  contracts and default serving behavior are unchanged.

## 0.1.14-alpha — candidate, 2026-10-21

- Add the versioned build-output contract and a static adapter for completed
  browser builds, including Vite output and explicit HTML-only SPA fallback.
- Validate static artifacts natively and serve them without React render workers.
  Existing React builds and legacy lifecycle validation remain supported.
- Fix native image callbacks when listening on a dynamically assigned port.
- Preserve dual-format client dependency boundaries and route work deadlines.
- Include the reviewed OG renderer security follow-up described below.

This candidate requires freshly built binaries for every supported platform.
Preparation and CI artifact verification do not publish packages to npm.

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
