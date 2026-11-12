# Upgrading an application to PRNext 0.2.0-alpha

This guide describes PRNext 0.2.0-alpha. Check the exact version on npm and its
matching GitHub prerelease before rollout, then qualify your application's
routes, dependencies and production build.

## Check the version boundary

Review dependency ranges when moving from 0.1 to 0.2. A caret range beginning
with `0.1` does not automatically adopt `0.2`. Keep the framework and installed
native package on the same exact version. The release retains the exact React,
React DOM and react-server-dom-webpack 19.3.1 peers. Node requirements remain
22.23.4+, 24.22.1+ or 26.12.1+.

Rebuild application output with the candidate rather than mixing old output
with new framework files. Stop existing managed applications with their current
CLI before replacing packages, using the same persistent process-manager home.
Retain a complete matching previous build for rollback and verify old browser
tabs against the deployment transition.

## Presentation rendering

Eligible production Node App Router presentation blocks are extracted and
compiled automatically. The compiled path can adopt verified descendants while
React retains the real host root and its attributes. Flat scalar pools and
adaptive official Flight binary columns reduce intermediate structures for
appropriate data. The generated HTML writer consumes checked packets directly;
outer Flight decoding and React's streaming boundaries remain in place.

Conditional JSX, proven immutable local scalar helpers and literal resource-free
SVG can be eligible. Unsupported code, getters, proxies or uncertain consumers
retain ordinary rendering. Application values are still evaluated on the
server, and compaction is not authorization or cross-user response caching.

Inspect `.prnext/presentation-report.json` and the build summary. Compare a
representative application with `presentationComponents: false` before drawing
conclusions about total CPU or memory. Development, Pages, Edge and HTML-only
rendering retain their existing paths. Custom pipelines may legitimately remain
ineligible.

## Browser loading and optional data adapters

Production App client entries resolve directly from checked Flight references.
Router subscriptions keep stable path, search and parameter values while
retaining Activity and Cache Components boundaries.

The explicit experimental `deferHydration()` API can activate a component when
visible, idle or interacted with. It retains SSR HTML while delaying code and
hydration. This shifts work and can increase first-interaction latency. Keep
critical controls eager and verify pointer, keyboard, focus and form behavior.

Query integration is optional. Install the tested TanStack Query peers in the
application before using the Node adapters. Reuse a request-owned QueryClient,
transfer its checked dehydrated state once and configure freshness deliberately.
Existing Query providers retain control. Scope state to the current account;
never turn user-specific queries into a shared global server cache. Query SSR
adapters do not support Edge.

## Compatibility additions

The candidate adds Form handling, link pending state, official Web Vitals,
client instrumentation, official compiler transforms, request-owned SSR style
insertion, additional image loaders and deferred Edge work. See the detailed
[compatibility contract](../packages/prnext/build/NEXT-COMPATIBILITY.md).

These additions do not provide complete Next.js compatibility. Arbitrary private
Next modules, full webpack/Turbopack engines and Next-specific executables remain
outside the supported contract. Run the migration audit, application type checks
and realistic authentication, navigation, Server Action, style and image tests.

## Resource policy and Windows commands

Fixed admission remains the default. `PRNEXT_RESOURCE_ADMISSION=1` is an explicit
experiment whose constrained-CPU comparisons still include latency regressions.
Do not enable it as an assumed VPS optimization.

Use `prnext` for every command on Windows and in portable scripts. Windows
reserves `PRN` even with `.cmd` or `.ps1`; `prn` remains a Unix shortcut. npm's
standard `prnext.cmd` launcher is available if PowerShell script policy blocks
the generated `.ps1`. No shell profile or system policy change is required.

## Qualification evidence

The implementation stack is tracked by PRs
[68](https://github.com/Lorkydey/PRNext/pull/68),
[69](https://github.com/Lorkydey/PRNext/pull/69),
[79](https://github.com/Lorkydey/PRNext/pull/79),
[80](https://github.com/Lorkydey/PRNext/pull/80),
[81](https://github.com/Lorkydey/PRNext/pull/81) and
[82](https://github.com/Lorkydey/PRNext/pull/82).
Their existing checks do not replace qualification of the renamed final source,
matching native archives and the application's own upgrade and rollback.

Controlled local comparisons include strong results for eligible repeated
presentation data and mixed results for animation-heavy pages. They used
specific earlier candidate sources and a shared Windows workstation, not a
universal production workload or an isolated VPS. Preserve these conditions
when interpreting release communication.
