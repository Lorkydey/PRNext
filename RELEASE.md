# Releases

## Candidate: 0.1.19-alpha

The 0.1.19-alpha source is being qualified. It is not available on npm; the
published version remains 0.1.18-alpha. Existing installation commands below
continue to select that published release.

This candidate strengthens Server Actions and Fast Refresh when mutations and
development updates overlap. Unchanged Action identities and mounted layout
state are preserved, obsolete Flight work cannot overwrite a newer generation,
and failed readiness publication leaves the last complete development state
available while retiring obsolete runtimes.

On macOS, coalesced directory notifications also invalidate deep source edits.
Bounded content snapshots are compared with the inputs actually consumed by the
compiler so identical generated output can remain stable. Incomplete coverage
is reported explicitly rather than certifying equality.

Opt-in `experimental.lazyDynamicImports` compiles eligible literal client imports
on first use. Deferred modules retain native ESM identity and live bindings,
and their CSS loads when activated. Private staging and complete asset receipts
prevent partially generated assets from becoming visible. Existing Action
proxies can be reused; introducing a new Action boundary through this path is
rejected. Activated styles remain loaded for the development generation, so
prefer CSS Modules or feature-local selectors. Unsupported configurations fail
explicitly. See the [installed troubleshooting guide](packages/prnext/docs/ai/troubleshooting.md).

Development compilation shares bounded incremental graphs and publishes affected
CSS as small overlays. Canonical ownership supports system and short-path aliases
without rewriting application literals. Production refinements bound idle Flight
base retention and avoid an unnecessary cache-buffer copy. An explicit
`Link prefetch={true}` now requests full prefetch outside Cache Components; the
destination is still revalidated at click time. These targeted changes do not
establish a general HTTP performance gain.

Migration diagnostics cover server/client realms, Redis adapters and unsupported
`.mts`/`.cts` boundaries without executing the audited modules; project
configuration is still evaluated. The independently
installed SaaS reference exercises bilingual routing, PostgreSQL-backed account
ownership, session renewal and revocation, verified OIDC, HTTPS cookies and
relocated standalone deployment. Functional qualification includes Linux,
macOS, Windows and Chromium, Firefox and WebKit. Archive qualification is tracked
separately for the exact versioned packages.

The release remains an experimental alpha with partial Next.js compatibility.
Run the migration audit and your application's own workflows before adopting it.
Earlier Windows `EPERM` observations during atomic development-state publication
have no demonstrated cause or specific fix. Historical performance reports with
incomplete process observations remain inconclusive; passing functional tests
does not resolve those missing measurements.

## Current release: 0.1.18-alpha

PRNext 0.1.18-alpha is available on npm, published on 30 October 2026 with all six
matching native packages. Both `latest` and `alpha` select this version. An
unversioned installation selects this release, which remains an experimental alpha:

```sh
npm i @thomas.f/prnext
```

Create a minimal TypeScript App Router project:

```sh
npx @thomas.f/prnext create my-app
cd my-app
npm run dev
```

The release adds project creation, opt-in React Compiler and its decision report,
native TypeScript 7 support, retained App Router state, prioritized prefetching,
bounded navigation recovery and differential Flight. Production changes include
optional Redis cache adapters, deployment-aware asset retention, route-scoped
styles, selected HTML-only pages and stronger resource and lifecycle bounds.
See [CHANGELOG.md](CHANGELOG.md) and the [release article](https://prnext.dev/blog/prnext-0-1-18-navigation-build-production).

The source was merged through [PR #27](https://github.com/Lorkydey/PRNext/pull/27)
at `eddd283e563efd2bc90facf47c7766c22746268b`. Its tree matches the validated
source `05a9ccd20e86a20698b4a37bdf6a6baa3411ceaf`. The
[required CI](https://github.com/Lorkydey/PRNext/actions/runs/40980719114) passed on
Linux, macOS and Windows, including Linux Next.js reference contracts. The two
reference-contract skips outside Linux are recorded separately.

The [six-platform archive checks](https://github.com/Lorkydey/PRNext/actions/runs/40980744198)
cover twelve isolated installations and eighteen lifecycle scenarios across
Node.js 22, 24 and 26. All seven public archives match their validated bytes.
A fresh Windows public-registry consumer verifies unversioned installation,
native resolution, bundled AI guides, a production build, SSR, Flight and a POST
route. Unversioned project creation also passes typecheck, build and development
HTTP checks outside the repository.

Use Node `^22.23.4 || ^24.22.1 || >=26.12.1` and the aligned React, React DOM and
react-server-dom-webpack 19.3.1 peers. Keep optional native dependencies enabled.
Keep framework and native versions aligned; rebuild and restart after upgrading.
React Compiler, Redis, staged navigation and HTML-only output are separate opt-ins.
Next.js compatibility remains partial. Historical VPS measurements identify their
tested source and do not establish new measurements for this release.

## 0.1.17-alpha - performance and development

This version adds requested-route development compilation, a stable Rust dev
listener, persistent dev caches, native Lightning CSS processing, background
TypeScript checks and opt-in typed routes. Middleware, rewrites and
parallel/intercepting routes retain complete development graphs.

Production changes include persistent transformation/runtime-bundle and Node/V8
worker caches, a Rust `pstart` proxy, indexed dynamic routing and precompressed
Brotli assets. Incremental build sessions, selected Rust/Oxc analyses, browser
bundle reports/budgets, opt-in worker preloading, post-switch rollback and HTTP/1
WebSocket tunnels are included as well.

The final increments make loader caches failure-tolerant, retain bounded Webpack
development compilers, publish affected CSS bundles selectively and transfer large
HMR dependency graphs as atomic bounded transactions. Installation diagnostics,
independent `typegen`/`typecheck`, workspace-aware npm/pnpm/Yarn migration and
per-route analysis regression budgets are included. SSR diagnostics expose fixed
stage outcomes and resource occupancy; queue waits are configurable, and the
absolute HTTP deadline is opt-in (`PRNEXT_REQUEST_TIMEOUT_MS=0` by default).

The npm package now includes [AI.md](packages/prnext/AI.md) and six focused guides.
`prnext docs --ai` reads documentation for the installed version without a native
binary or network access. `prnext docs --ai --init` explicitly adds a reference
to an application's existing `AGENTS.md`; installation itself changes no project
instructions. Development tools also include the console, inspector, device
previews and local MCP tools with observed build/browser verification.

The source was merged through [PR #18](https://github.com/Lorkydey/PRNext/pull/18)
at `7a0bfc16596c739f65618b7b4188a6f1377371a1`, whose tree is identical to the final
tested source `6064a6dbb357d3873728079d0680f066a96ef3c9`.
The [required CI](https://github.com/Lorkydey/PRNext/actions/runs/40382668882)
passed all 14 jobs on that final source, including native builds, unit/type
checks, integration tests and browser tests on Windows, Linux and macOS.

The [fresh native archive matrix](https://github.com/Lorkydey/PRNext/actions/runs/40355448636)
validated macOS x64/ARM64, Linux GNU x64/ARM64 and Windows MSVC x64/ARM64.
The exact seven archives have twelve hoisted/nested installation receipts and
eighteen lifecycle receipts on Node 22.23.4, 24.22.1 and 26.12.1.
The [full Linux release checks](https://github.com/Lorkydey/PRNext/actions/runs/40355453474)
also passed: 969 JavaScript tests, 200 Rust tests and 354 integration tests;
eight JavaScript skips and one ignored manual Rust benchmark
are recorded separately.

Those archives contain runtime source `69dc7b540131399cecb630e267405779c07dc05e`.
An explicit source-equivalence proof checks that only six validation files changed
before the final tested source: all 1,062 other Git entries, including package,
Rust, dependency, workflow and lifecycle inputs, remain identical through every
intermediate commit. Archive verification matches 332 framework files to their
committed Git blobs and all six native executables to their build receipts.
These proofs and the unchanged archive/install/lifecycle receipts are retained in
`artifacts/npm-launch-20261026/`; they apply only to their recorded hashes.
The [optimization report](tests/performance/NPM-IMPROVEMENTS-20261026.md) and
[earlier preflight](tests/performance/PREFLIGHT-0.1.17.md) remain historical
snapshots, rather than substitutes for this final release verification.

Use Node `^22.23.4 || ^24.22.1 || >=26.12.1` and the aligned React, React DOM and
react-server-dom-webpack 19.3.1 peers. Keep optional native dependencies enabled.
Next.js compatibility remains partial; consult [COMPATIBILITY.md](COMPATIBILITY.md).
Historical benchmark results below are not measurements of the final 0.1.17
publication bytes. No general performance multiplier is claimed for this launch.

## Previous published release - 22 October 2026

On 22 October 2026, `@thomas.f/prnext@0.1.16-alpha` and all six matching native
packages were published to npm; the framework's `alpha` tag then selected that
version. Public registry archives were verified byte-for-byte against the
archives that passed the six-platform release checks. A fresh registry
installation also passed native binary verification, React 19.3.1 resolution,
an App Router build, production SSR and dynamic RSC checks.

Version 0.1.16-alpha requires React, React DOM and react-server-dom-webpack
19.3.1 together, fixing the October 14 React Server Components advisories.
Update all three peers, rebuild applications and replace deployed artifacts.
App Router builds reject an old or mixed React family. Release validation also
rejects vulnerable React versions even when npm audit returns no findings.

The 0.1.15-alpha TLS, image renderer and patched Node requirements remain.
Application-specific Next.js/sharp dependencies and Node executables must still
be reviewed separately; the PRNext npm package does not replace those services.

## Historical source release — 0.1.14-alpha

Version 0.1.14-alpha adds a versioned static build adapter, exclusive build
publication, static gzip precompression and sampled inspector/OTLP diagnostics.
The source also includes the latest main-branch credential-path, local-image,
stdio-drain and browser-observation fixes. Next.js compatibility remains partial.

At that source release, the npm alpha tag still pointed to 0.1.13-alpha;
the GitHub 0.1.14-alpha source prerelease was separate from npm availability.
This historical status is superseded by the later npm publications recorded above.
Its Node 22/24 checks certify only their recorded hashes, not 0.1.17-alpha.

The inspector's OTLP/JSON export is a bounded snapshot of response-header timings,
using the custom `prnext.http.response.headers.duration` metric in seconds. It is
not a continuously exported complete-response or billing metric.


## Historical security follow-up (16 October 2026)

At this point, the local OG renderer fix was not part of the published
0.1.13-alpha archive. It required a new version rather than overwriting the
published archive. This was a preparation note, not a publication receipt.

`npm run release:prepare-og` reproducibly rebuilds the shipped renderer from the
locked `@vercel/og` development dependency and patched fflate 0.7.5. It refuses
an unexpected upstream bundle layout. Review and commit the generated
`packages/prnext/runtime/og/` assets and licenses. `release:check` requires these
assets and refuses the old production dependency or embedded version marker.
Verify a packed archive in a fresh consumer installation, not only the monorepo
lockfile: root overrides are not inherited by consumers. Preserve ImageResponse
rendering, including compressed WOFF fonts, when changing this dependency.

## Historical 0.1.13-alpha release preparation

This was a runtime release, not a metadata-only update. Its Linux process
lifecycle changes required fresh native builds rather than reuse of 0.1.12
archives. The evidence below remains tied to those historical bytes.

## Historical performance evidence — 15 October 2026

The October 15 campaign compared a **frozen local 0.1.13-alpha candidate**, not
the public npm release, against Next.js 16.4.1 and TanStack Start 1.169.2
(Router 1.170.44, Vite 8.3.4, Nitro 3.0.260903-beta). Node was 24.22.0;
the application React family was 19.3.0. Next App Router used its bundled React
canary. Nitro's adapter was beta. A separate React 19.3.1 compatibility control
was not the source of these throughput numbers.

Production, one server CPU, identity encoding, five repetitions of 10 seconds
warmup plus 30 seconds measurement. SSR renders 100 rows at 64 connections;
streaming waits 40 ms at 128 connections; JSON returns 16 rows at 64 connections.
Next and PRNext used the same sources; TanStack implemented the same workload
with its own architecture. Response freshness, cookie separation and progressive
streaming were checked. No dynamic page cache was added. Generator CPU was
separate; server CPU includes terminated descendants and RSS sums the process
tree (shared pages can be counted more than once).

| Platform / workload | Next req/s | PRNext balanced req/s | Next / PRNext RSS (MiB) | Next / PRNext CPU per response (ms) |
| --- | ---: | ---: | ---: | ---: |
| Windows / SSR | 281.00 | 364.63 | 362.03 / 181.59 | — |
| Windows / streaming | 558.37 | 564.87 | 375.14 / 212.24 | — |
| Windows / JSON | 2047.37 | 1955.43 | 324.68 / 133.11 | — |
| Linux / SSR | 157.77 | 217.70 | 246.58 / 149.39 | 6.255 / 4.595 |
| Linux / streaming | 277.30 | 437.43 | 251.27 / 163.49 | 3.577 / 2.278 |
| Linux / JSON | 1050.33 | 1415.93 | 224.69 / 126.29 | 0.951 / 0.705 |

Windows: Ryzen 5 3600, 32 GiB, Windows 11 Pro 26100. Linux: shared Ubuntu
26.04 x64 VPS, 8 Haswell-class vCPUs, about 23 GiB usable RAM. Do not compare
absolute throughput across these machines. Windows streaming ranges overlapped;
Windows JSON was slower than Next. TanStack was faster on these App-style
fixtures (Linux SSR/streaming/JSON: 736.87/1006.23/5460.30 req/s). A separate
traditional Pages SSR fixture favored PRNext. This is not universal Next.js
compatibility or a claim to outperform every framework.

Six 30-minute fixed-load endurance runs totaled 2,213,996 ordinary responses
without generator errors, plus separately classified intentional cancellations.
Failed setup/memory-constrained trials were retained and excluded explicitly;
not every attempted test passed. Fifteen-minute idle observations showed PRNext
releasing Node workers, with Linux RSS 11.86 MiB and a 393.62 ms first SSR response;
Next retained 202.99 MiB and responded in 32.94 ms. Those wake latencies are single
observations. An unchanged CPU counter at its sampling resolution means no
measurable CPU over that interval, not guaranteed zero CPU.

The direct Route Handler adapter experiment subsequently improved JSON throughput
by 6.37% on Windows and 7.95% on Linux in three repeated paired controls, with
Linux RSS **increasing** 121.99 → 124.18 MiB. The final shutdown integration is
later again: do not relabel the historical campaign as a benchmark of final
publication bytes. No new performance claim follows merely from passing its
functional release checks.

Retained evidence: `artifacts/framework-comparison-20261015/final/report.html`
(SHA-256 `9f4f580f3c526183132bffb832a39398cc1451bb842e50198bd776ae398b1066`).
Frozen measured executables: Windows
`7ae162f468b6a2b99216f41f96acf579aeae65e441c0008757da53b44e462066`,
Linux `d8f97bf52a474b47349862cf1643e3106a3977d479d027fb2619c4dcc5ca7137`.
The ignored evidence directory must be distributed separately for public
reproduction; it is not included by a Git push or npm publication.

## Application upgrades

Install the intended published alpha and the aligned React, React DOM and RSC
19.3.1 peers with optional native dependencies enabled. Use the supported patched
Node range above. For TypeScript applications, run `prnext typecheck` separately;
`prnext check` does not establish semantic type correctness or browser behavior.
Use `.ts`/`.tsx` for React server/client directives: `.mts`/`.cts` boundaries are
now rejected before build activation. Start with `prnext dev --safe` when
diagnosing incremental development behavior.

After installing the release, run `prnext build <project>` and restart the
server/host so the new runtime modules are included. Rebuild standalone output
on its deployment OS/architecture and replace the whole output. `pstart` users
rebuild before `prestart`. Dynamic builds predating the lifecycle contract are
rejected before listening; do not copy a contract file to old runtime modules.
CLI/environment retirement overrides require a restart; application config/runtime/source
changes require a rebuild. Static-only legacy builds without worker routes or
middleware can still serve files without Node.

See [CHANGELOG.md](CHANGELOG.md) for the reproduced experimental 1 GiB memory
regression, supported configuration options and remaining alpha limits.
