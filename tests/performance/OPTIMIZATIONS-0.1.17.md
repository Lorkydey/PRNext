# PRNext 0.1.17 optimization checks, 2026-10-24

These are local candidate changes, not a published package or production rollout.
The original VPS comparison identified sequential SSR latency, cached rebuilds
and browser HMR as weaknesses. Fresh paired measurements isolate the changes below.

| Metric | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Sequential SSR p95 | 52.7 ms | 12.3 ms | 77% |
| Production rebuild with cache | 7.31 s | 3.34 s | 54% |
| Production build after a source edit | 7.30 s | 3.54 s | 52% |
| Production build, fresh project cache | 5.64 s | 3.69 s | 35% |
| Browser edit to visible update | 2.324 s | 1.798 s | 23% |

Sequential SSR throughput increases from 20.6 to 138.4 responses/s. At 32
connections throughput remains 168.4 responses/s; p95 is 224.8 versus 231.1 ms.
There is no demonstrated high-concurrency gain. These medians do not establish
an endurance or capacity guarantee. HMR remains substantially slower than the
76 ms Next.js result in the original comparison; these changes reduce the gap.

## Changes and safety contracts

- Rust HTTP listeners set `TCP_NODELAY` on accepted streams before HTTP starts.
  A response header followed by small streamed body chunks no longer waits for
  Nagle/delayed ACK interaction. The SSR comparison uses the exact same immutable
  build with only the native binary changed. No SSR response cache is introduced.
- Compression cache publication previously rescanned/statted/sorted the whole
  cache after each file. One index now tracks bytes, overwrites and oldest-entry
  eviction. The two compressors serialize publication/eviction; the 512-file,
  64 MiB cache and 4 MiB item limits remain. Reuse still decodes and hashes the
  actual cached bytes. Unavailable cache storage does not fail correct outputs.
- App compilation previously repeated RSC, SSR and browser graphs after ordinary
  RSC boundary discovery, even though the later graphs already consumed it.
  Convergence now checks what each graph actually consumed. Late action IDs,
  boundary/edge changes, CSS and native dependency discoveries still repeat the
  required passes. Action implementations and keys remain server-only.

Diagnostic profiles on two CPUs show a cached compression phase falling from
4.22 s to 0.76 s and the edited App compiler phase from 0.66 s to 0.34 s. Profiles
are supporting diagnostics; the table uses uninstrumented end-to-end timings.
The existing esbuild contexts were already reused; no graph-cache miss fix is
claimed. The stable dev listener, immutable generations, response draining and
React state/document preservation are retained.

## Measurement method

- Existing PRNext VPS, eight virtual Haswell CPUs, Node 24.22.1, React/React DOM/
  RSC 19.3.1. Scratch workspace only; production services, configuration and data
  are outside the experiment.
- Identical source fixture: 100 extra routes, a dynamic SSR table of 100 rows,
  client Counter, streaming route, API and static routes. The baseline source
  snapshot is shared with the previous 0.1.17 benchmark. The baseline native
  SHA-256 is `ecabb8185430998457f62fe48b207bd73445b75674204913fda00abc77f191d1`.
- Three alternating before/after rounds. SSR server: CPU 4, 100% CPU quota, 2 GiB;
  generator: CPU 5. One-second warmup and five-second measured windows for both
  one and 32 connections. Medians of per-run p95/rates, not merged histograms.
  7,755 measured responses, zero load errors. Dynamic freshness, isolated cookies,
  progressive streaming and normal cancellation are checked separately.
- Builds: CPUs 4/5, three fresh project paths per variant. Each has one initial
  build, two same-path cached builds and one edited build. Same installed
  dependency tree; fresh project cache does not mean a flushed OS filesystem cache.
- HMR: one server CPU; real Chromium on Windows through a persistent SSH tunnel.
  Two routes are hydrated before edits. Three sessions per variant, three edits
  each; all 18 edits preserve Counter state and the same document, with no page
  errors. Timing includes RPC/network and browser presentation, not just compile
  time. Median write acknowledgment is 34.0 ms before and 32.2 ms after; it is
  included, not subtracted. No repeated HTTP polling competes with compilation.
- Results concern loopback HTTP and a synthetic workload on a shared VPS. They
  do not predict TLS/CDN, arbitrary applications, end-user networks or long runs.
  The prior Next.js results are context, not a new paired Next.js campaign.

Raw scripts, fixture hashes, profiles, binaries, per-run load/build/browser data
and validation logs are retained locally in
`artifacts/opt-0.1.17-20261024/`. `summary.json` is derived only when all paired
measurement sets are complete. Failed harness attempts are retained separately
and excluded from results.

## Functional validation

- Windows: 887 general unit tests passed, one optional C-addon relocation test
  skipped. The final focused suites pass 16 tests plus the same optional skip,
  including the added late-action/client-CSS regression in production and dev.
- Rust: 184 tests passed, one existing manual test ignored; formatting and
  warning-free Clippy checks pass. Locked release binaries build for Windows and
  Linux x64. Windows validation uses its own target directory, preserving the
  running development playground's executable.
- VPS Linux: 24 focused compiler/compression/action/incremental tests pass, one
  optional C-addon test skipped; all 60 selected integration tests pass. These
  cover App routing/static generation, actions/edge actions, request isolation,
  streaming/cancellation, dev on-demand, document and cache behavior.
- Chromium/Windows: all 17 selected scenarios pass, including App/Pages component,
  CSS and server-data refresh, exact source reverts, syntax/import recovery,
  global errors, cached HTML hydration and browser Server Actions.
- TypeScript and local release metadata checks pass. No dependency or package
  version change is needed for these fixes.
- Production service PIDs remain unchanged; all three checked public HTTPS sites
  return 200. Temporary services/tunnels are closed and approximately 1.01 GB of
  isolated fixtures/dependencies is removed. No production deployment, GitHub
  push or npm publication was performed.
