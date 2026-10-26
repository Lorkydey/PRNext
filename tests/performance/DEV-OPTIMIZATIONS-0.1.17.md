# Development and build optimizations — 0.1.17 local candidate

Validated on 2026-10-24. This candidate is not published to npm, pushed to
GitHub or deployed to production. The baseline is the already optimized local
0.1.17 candidate from [the earlier campaign](OPTIMIZATIONS-0.1.17.md), not
0.1.16 and not a new Next.js comparison.

## Paired VPS measurements

| Measurement | Before | After | Change |
| --- | ---: | ---: | ---: |
| Browser CSS refresh | 1,951 ms | 297 ms | −84.8% |
| Browser JavaScript Fast Refresh | 1,964 ms | 1,819 ms | −7.4% |
| Production build, persistent cache | 3,535 ms | 3,370 ms | −4.7% |
| Production build after a source edit | 3,542 ms | 3,394 ms | −4.2% |
| Initial production build | 3,580 ms | 3,538 ms | −1.2% |
| Dynamic SSR p95, one connection | 10.9 ms | 10.3 ms | Comparable |
| Dynamic SSR p95, 32 connections | 202.4 ms | 200.2 ms | Comparable |

Small changes in builds, JavaScript refresh and SSR on a shared VPS should not
be treated as guaranteed gains for arbitrary applications. CSS is the clear
improvement in this workload. No response caching is used to improve SSR scores.

Method: the same 100-extra-route fixture, Node 24.22.1 and React/React DOM/RSC
19.3.1, on the existing eight-vCPU Haswell VPS. Builds use CPUs 4/5 and a two-CPU
quota; servers use CPU 4 and one CPU, with control/load on CPU 5. Each framework
variant has three fresh build paths, each with an initial build, two cached builds
and an edited build. A fresh project cache does not imply a flushed OS cache.

Real Chromium runs through a persistent SSH tunnel, with two hydrated routes,
three sessions per variant and three JS plus three CSS edits per session.
Refresh values are the median of the three session medians. They include source
write RPC, network and presentation. All 36 edits retain React state and the
original document; there are no browser errors. No local compilation or endurance
run overlaps these browser measurements.

SSR uses the same immutable production build with only the native binary changed,
three alternating rounds, a one-second warmup and five-second measurement windows.
There are 10,690 measured responses and zero load errors. Independent probes check
dynamic freshness, cookie isolation, progressive streaming and cancellation.
These are synthetic loopback HTTP results, not TLS/CDN or end-user latency.

## Implemented behavior

1. **Indexed development dependencies.** Rust maintains separate bounded reverse
   indexes for routes and modules. Changes invalidate affected refresh boundaries;
   unrelated tabs acknowledge the new generation without re-fetching their model.
   Edits to unopened route files wait until that route is needed. Existing esbuild
   contexts still coordinate the active graphs; this does not claim to eliminate
   every server compilation pass for a client edit. Unknown dependencies, Server
   Actions and custom graph behavior retain conservative invalidation.
2. **CSS-only updates.** Recompile styles and publish immutable asset generations
   without recompiling JS, importing a new React graph or replacing the server
   process. Compare JS-visible CSS Module mappings before accepting the fast path.
   Export changes, Sass and custom processors retain the full compiler. Atomic
   writes protect hardlinked prior builds, and retained manifests/generations are
   bounded. Fresh navigation also receives the current styles.
3. **Prewarmed workers.** Warm React dependencies while compilation runs, then
   authenticate the handoff to exactly one immutable generation. A Rust supervisor
   owns each Node process, including blocked V8 loops and parent loss. The native
   backend tracks its lease, activity and background work through retirement;
   cache services stay available while that work drains. Forced process termination
   can interrupt unfinished work. Warmup failure falls back to normal startup;
   production, maintenance workers and alternate scripts keep their existing path.
4. **Deferred developer interfaces.** Load the workbench and inspector only when
   requested. Early console/error capture remains active. Reserve popups during
   the original user gesture and close reservations if loading fails or the user
   dismisses a pending interface.
5. **Bounded parallel prerender.** Render independent production routes with at
   most four concurrent jobs, reduced to available CPU parallelism. Keep error
   pages first, deterministic manifest ordering and duplicate-path validation.
   Stop scheduling on failure and await in-flight work before discarding a stage.
6. **Compression reuse.** Bundle analysis consumes sidecar sizes after the build's
   validated precompression stage. Standalone analysis and assets without usable
   sidecars still perform compression. Gzip/Brotli are not calculated twice merely
   to report the build's already compressed sizes.
7. **Adaptive compiler recycling.** Replace the fixed 24-build restart with RSS,
   heap and sustained-growth checks plus a 256-build backstop. Defaults are 768 MiB
   RSS and 384 MiB heap, with a bounded sampling window. Diagnostics expose the
   reason for recycling. The health sample measures the compiler's Node process,
   not the aggregate RSS of its entire process tree.
8. **Endurance and regression checks.** An opt-in test edits two real browser tabs
   20–2,000 times, preserves state, checks retained directories and samples browser
   heap after GC. A manual workflow targets a dedicated performance runner, keeping
   this expensive job out of ordinary PR runs. Optional baseline comparison requires
   matching CPU model, platform, architecture, Node and workload; p95 is limited to
   1.25× baseline plus 25 ms. Use the same dedicated machine and CPU limits when
   supplying a baseline, rather than comparing unrelated hosts with the same model.

## Validation

- General JavaScript suite: 894 passed, one optional native-addon skip. The added
  concurrency/health, real CSS snapshot, lazy-interface and performance-gate checks
  pass. Focused checks cover the final primitive-error and malformed-report cases.
- Rust: 186 passed, one existing manual test ignored. Final-source formatting,
  warning-free Clippy and locked Windows/Linux x64 release builds pass. The Linux
  cross-linker reports its existing deprecated optimization-setting warning.
- Linux: 28 focused unit tests passed, one optional skip; all 66 selected integration
  tests passed. Final native supervision/retirement tests pass on both platforms;
  nine further Linux style/environment checks pass against the final native binary.
- Chromium: 60 existing selected scenarios pass, with a stale tooltip assertion
  updated to the existing detailed tooltip format; four new optimization scenarios
  cover CSS/PID/state, exact mapping reversions, unrelated routes and lazy tools.
- Endurance: 500 edits (100 JS, 400 CSS), two tabs, no page errors and preserved
  counter/document state. Post-GC browser heap grows by 2,298,700 bytes (2.2 MiB).
  The compiler performs 102 builds with zero recycling, reaches 290 MiB sampled
  RSS, and finishes at 234 MiB. Runtime/style generations remain bounded to three
  each. This Windows run overlaps native compilation early in the run, so its
  timing distribution is not used for the paired performance table.
- The 500-edit run uses the candidate before the final native change that applies
  existing Node profile flags to prewarmed workers. All paired VPS measurements use
  the final binary. The final Windows binary also receives dedicated supervision,
  retirement and all four new browser checks, plus a fresh 20-edit/two-tab run.
  TypeScript and local release metadata checks pass.

The baseline Linux binary SHA-256 is
`8c79beeb10942edba0b9f2f34e59ed211e829466119d2e74df7470541c7615c6`;
the final Linux binary is
`d3def3ef2f4b54eca64f1b4a4ead0fff439d28b21733566f77e73ea6cdea08a1`.
Raw source snapshots, binaries, per-run measurements, validation logs and harness
failures are retained locally in `artifacts/opt2-0.1.17-20261024/`.

The experiment uses scratch projects and transient services only. All transient
services/tunnels are closed and 15 scratch dependency/fixture directories are
removed. Production service PIDs remain unchanged; `prnext.dev`, `app.prnext.dev`
and `rblv.lol` return 200. Existing configuration and databases are preserved.
