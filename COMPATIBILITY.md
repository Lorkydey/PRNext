# PRNext compatibility scope

PRNext is an alpha React runtime with its own build pipeline, a Rust HTTP server
and Node/V8 rendering workers. Compatibility with Next.js is partial. Passing
preflight is not a guarantee that every feature used by an application works.
This scope includes the 0.1.22-alpha candidate. Check [release status](RELEASE.md)
and the installed package's version before
applying it to an older release; the package also includes
[version-specific AI guides](packages/prnext/AI.md), available through
`prnext docs --ai`.

| Input | Current path | Boundary |
| --- | --- | --- |
| React with `pages/` or `app/` conventions | Default `prnext build` | Supported conventions are implemented by PRNext; Next.js internals are not a public integration interface. |
| Automatic presentation | Default production Node App Router build | Eligible pure display components use compact Flight with complete SSR. Expressions remain server-side. Unsupported components, custom webpack/JSX pipelines, Pages, Edge, development and HTML-only builds retain ordinary rendering. Eligibility reports describe compilation, not runtime hit rates. Disable with `presentationComponents: false`. |
| App Router SSR, streaming, RSC and Server Actions | Default React adapter | Matching supported React/React DOM/RSC versions are required. Validate application behavior before migration. |
| TypeScript | Default React adapter; `prnext typegen` / `prnext typecheck` | Application-installed TypeScript 7 uses its native CLI; TypeScript 5/6 retain their compiler API path. Background diagnostics and typed routes support both paths. Production build checks remain opt-in through `typescript`. The Next.js editor plugin is not implemented. |
| Connection recovery | App navigation GETs | Bounded retries preserve the mounted page and cancel superseded navigation. Actions/POSTs are never replayed. The optional `useOffline` hook exposes connection/recovery state; this does not add persistent offline storage or Pages navigation recovery. |
| Differential Flight | Negotiated App navigation GETs | Fresh authorized renders can reuse exact bytes from one recent Flight response. Opaque bases are isolated by deployment and credentials, expire after 30 seconds and have bounded memory. This reduces transfer size; it does not skip server rendering or authorization. |
| Lazy development destinations | Default `prnext dev` | Middleware and rewrites route the original request once. Cold destinations and retained parallel branches compile on demand without replaying uploads or actions. `--safe` retains complete builds. |
| Instrumentation | Root or `src/instrumentation.ts` / `.js` | Async `register` and `onRequestError` run in the corresponding Node, RSC or Edge realm. Startup failures block application execution; error reporting is bounded and does not replace the original error. |
| Correlated traces | Optional OTLP/HTTP JSON | Explicit exporter configuration enables bounded native HTTP, Node, RSC and fetch spans. Application OpenTelemetry providers can join the propagated context. No SDK or exporter is required by default. |
| Retained App pages | Default App Router layout branches | React Activity preserves inactive UI with a shared four-branch/two-minute budget. Hidden effects stop; history is authorized again. Actions, refresh and observed authorization changes purge inactive state. With `navigationCache.authCookies`, changed or unknown account identities require a fresh document before retained layouts/pages are adopted; verified same-account drafts can stay. Strict PPR previews wait for identity. Configure or disable with `navigationCache`. |
| Navigation stages | Opt-in `cacheComponents` and `partialPrefetching` | `navigation()` defers runtime work until navigation; `prefetch()` permits per-link work. Static prerenders continue through both gates. `ensureStatic` constrains selected stages, with complete server-output validation for `'navigation'`. |
| Shared Redis cache | Optional `@thomas.f/prnext/cache/redis` handlers | `createRedisCache` handles Cache Components; `createRedisIncrementalCache` handles native HTML/ISR, fetch and `unstable_cache`. Both use fenced cross-process leases and atomic tags. Requires a separately installed node-redis client. See the [cache guide](packages/prnext/docs/ai/data.md#shared-redis-cache-components). |
| Public request origin | `server.publicOrigin` and `server.trustedProxies` | The canonical external origin takes precedence. Only allowed immediate TCP peers may supply forwarded host/protocol. This does not establish a forwarded client-IP chain. Rebuild after changing the saved configuration. |
| Health and rollback | Native readiness plus an optional application health route | Complete bounded HTTP 200 responses are required; redirects fail. Native readiness becomes unavailable when draining starts and does not certify databases or lazy workers. Post-switch rollback requires the retained instance to remain healthy and never replays requests. |
| Continuous HTTP metrics | Opt-in `PRNEXT_METRICS_TOKEN` protected endpoint | Bounded labels, duration histograms, response/admission/worker outcomes and native exporter-loss counters. Keep scrapes private. Node exporter-loss diagnostics use `prnext.telemetry`; no production SLA is implied. |
| Typed routes | Opt-in `typedRoutes: true` | PRNext generates its own route registry for supported Link/router calls and the `route()` helper. It does not consume Next.js-generated route declarations. |
| Static HTML, CSS, JavaScript and public assets | `--adapter static --from dist` | Import an already-built public directory with a root `index.html`. No React installation is needed in that project. |
| Vite client applications, including React or Vue | Static adapter, optionally `--spa` | The original framework performs compilation; PRNext serves the browser output. This does not add SSR support for that framework. |
| Nuxt, SvelteKit, Astro or TanStack Start server output | No generic server adapter yet | Server entrypoints need a dedicated integration. Do not import server bundles as public files. Static exports can be imported if they meet the static contract. |
| React Compiler | Opt-in `reactCompiler: true` | Bundled official compiler for project-owned browser components and App Client Component server rendering. Pages server rendering, APIs/data loaders, Server Components, Server Actions, framework modules and npm packages stay outside the transform. Disabled by default. See the [compiler guide](packages/prnext/docs/ai/compatibility.md#react-compiler). |
| HTTP/1 WebSockets | Tunnels through external HTTP(S) rewrites, `pstart` and multi-app `host` | The upstream must implement WebSockets. App/Pages handlers do not gain a WebSocket server API. Other protocol upgrades are rejected; generation drains can close remaining tunnels. |

For the 0.1.22-alpha candidate, follow the [upgrade guide](docs/UPGRADING-0.1.22.md)
and [health, rollback and monitoring guide](docs/PRODUCTION-OPERATIONS.md).

## Alpha compatibility and maintenance contract

PRNext is early-access software. An application can qualify a pinned alpha for
its own production pilot; this does not make every supported convention, later
alpha or hosting environment production-ready. This document describes the
framework package. PRNext Host has separate infrastructure, account, billing and
recovery requirements.

Use the documentation and release notes for the version actually installed.
`main` can contain fixes that are not yet in an npm package. A passing source CI
run, a GitHub prerelease and a published npm artifact are distinct evidence.
The [release status](RELEASE.md) records npm availability. A deployment needs the
matching framework and native package, a rebuilt application and restarted
workers; an installation or source update does not change a running service.

| Boundary | Current contract |
| --- | --- |
| Node.js | Package metadata accepts `^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1`. The main platform matrix uses 22.23.4; additional Linux CI suites cover 26.13.0 runtime/HTTP, Chromium, the independent SaaS consumer and packaged installations. Release-artifact lifecycle checks separately exercise 22.23.4, 24.22.1 and 26.12.1. These scopes do not change a deployment's selected runtime or certify every version satisfying `engines`. Use a security-maintained Node line and requalify runtime changes; see [Node qualification](docs/NODE-QUALIFICATION.md). |
| React runtime | `react`, `react-dom` and `react-server-dom-webpack` must all be exactly 19.3.1 for the 0.1.21-alpha candidate. Mixing peer versions or using an unqualified canary is outside this scope. |
| Native packages | Prebuilt targets are macOS x64/arm64, Linux glibc x64/arm64 and Windows MSVC x64/arm64. Alpine/musl has no prebuilt package. Build and test the deployment artifact for its actual target; copying `node_modules` across targets is unsupported. |
| Continuous platform checks | The full source matrix uses Ubuntu 24.04, macOS 15 and Windows Server 2022. Chromium runs in that matrix; Firefox and WebKit have separate Linux compatibility checks. This is not certification of every OS, browser or architecture. The six-target package workflow is a separate release check. |
| Public application interfaces | The conventions in the scope table, documented package exports and CLI/configuration options form the current integration surface. Private runtime modules, generated files and Next.js internals are not extension APIs. Partial Next.js compatibility requires application-specific tests. |
| Experimental options | Opting in does not extend the compatibility scope. In particular, React Compiler, typed routes, `cacheComponents`, `partialPrefetching`, `experimental.lazyDynamicImports` and exporter/cache integrations need their own application qualification. Keep a configuration baseline and check release notes before retaining opt-ins on upgrade. |
| Version changes | Alpha updates can change behavior and interfaces, including between successive `0.1.x-alpha` versions. Pin an exact version and lockfile. Review release notes and any upgrade guide, rebuild, then qualify an upgrade before switching traffic. |
| Changes and deprecations | Release notes must identify known user-visible incompatibilities, configuration changes and required migration steps. Deprecation warnings and a transition path are preferred when practical, but alpha releases do not guarantee a minimum deprecation window. A security fix may require an immediate incompatible change. |
| Security maintenance | Fixes are developed on current `main` and shipped in a new version. Older alphas do not receive separate backports. See the [security policy](SECURITY.md) for private reporting and response scope. There is no promised response time, uptime SLA or fixed support period. |

These checks establish bounded compatibility, not general application correctness.
Database schemas, authorization decisions, backups and transactional idempotency
remain application responsibilities. Verify logout and account switching with
the application's real cookies and identity provider; a successful login alone
does not establish private-state isolation.

## Qualify an application pilot

A useful pilot runs the candidate artifact for 7-14 consecutive days with the
application's real integration patterns and controlled test accounts. This is a
recommended observation period, not an automatic certification. A synthetic
two-hour endurance test and a longer pilot answer different questions. Never
describe a configured duration or a running campaign as completed evidence.

Before starting, record the exact npm version, artifact hashes, source commit
when known, lockfile, build configuration, native target, Node and peer versions,
proxy topology, resource limits, dependency versions and deployment procedure.
Keep credentials and personal data out of the record. Choose traffic levels and
acceptance thresholds before collecting results. Pin the candidate; a code,
runtime, dependency or relevant configuration change starts a new qualification
window, while evidence from the preceding candidate remains available.

Include authenticated reads and writes, account A -> logout -> account B,
browser navigation and refresh, cache hits and invalidation, cancelled streams,
worker rotations and several version replacements. Exercise rollback with a
replacement that is initially healthy and then fails. Test unavailable
dependencies and recovery in an isolated environment, using disposable data.
Verify restoration from backup separately; a successful backup command does not
show that the application can be restored.

### Measurement and acceptance record

The application owner must approve its objectives. The values below are an
**illustrative starting point**, not PRNext defaults, a vendor promise or a
substitute for an application's requirements. Reuse existing monitoring; do not
publish private scrape endpoints or metric credentials.

| Signal | Measurement | Illustrative acceptance criterion |
| --- | --- | --- |
| Availability | External HTTPS probe every 5 seconds with a fixed deadline and expected status/body. Record every scheduled probe, including missed probes and timeouts. Success ratio is successful scheduled probes / all scheduled probes; report coverage separately. | At least 99.9% successful probes over the complete pilot. Missing monitoring evidence makes the corresponding interval inconclusive, rather than healthy. |
| Request latency | Report p50/p95/p99 per critical operation and load band. Include failed/timed-out requests and their counts; report successful-request latency separately. Measure streaming first byte and completion separately. | For one ordinary API read: p95 <= 300 ms and p99 <= 1 s at the agreed traffic level; an operation exceeding its deadline fails. Choose separate budgets for writes and streams. |
| Rotations and replacements | Correlate each switch with probes, client outcomes, old/new process identity, readiness and drain/rollback events. Include planned deployments in availability figures. | No unexplained connection loss or server errors on the critical journey during each controlled switch; successful health checks alone do not pass this gate. Any interruption requires a recorded decision against the service's agreed downtime budget. |
| Mutation correctness | Give each test operation a stable application idempotency key. Reconcile submitted operations, client results and committed database records after injected response loss and explicit retry. | Exactly one committed effect per accepted key, no automatic replay, and no cross-account data exposure. A lost response can leave the client outcome unknown; reconcile it before retrying. |
| Resource stability | Sample native and worker RSS, CPU, file descriptors/handles, database connections, restarts, queue saturation and telemetry-loss counters. Separate warm-up, steady load and deployment peaks. | No unexplained sustained growth across comparable load windows, resource exhaustion or unexpected restart. Define memory/connection/headroom ceilings from the deployment's actual limits before the pilot. |
| Recovery | Measure detection, rollback or restoration time and verified data loss using a disposable recovery exercise. Check the restored application's authenticated reads and writes. | Meet the application's predeclared recovery-time and recovery-point objectives. Retain a working previous artifact and compatible schema; rollback of code does not undo data writes. |

For each objective, record the owner, observation window, traffic, formula,
threshold, result, evidence location and open incidents. Report the sample count
for every percentile; with fewer than 1,000 observations for an operation, treat
tail-latency conclusions as provisional. Do not average percentiles from separate
windows: aggregate compatible histogram buckets or raw observations, or report
each window separately. Small samples can miss rare failures even when all
observations pass.

Keep raw failures. Identify client cancellations separately, but do not relabel
server timeouts or absent observations as cancellations to improve a result.
An independent client-side probe is needed because a process that crashes may
not emit its final metrics. Check exporter drop/failure counters and monitoring
coverage alongside latency and error rates. Apply alerting to successive short
windows as well as the pilot total, so a long healthy interval cannot hide a
short severe outage.

Record a final decision as **pass**, **fail** or **inconclusive** for each gate,
with any accepted risk and its owner. Green CI and a passed pilot support the
named application, artifact and operating envelope. They do not certify other
applications, later versions or an untested PRNext Host deployment.

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
