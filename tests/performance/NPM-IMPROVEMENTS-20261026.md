# Framework improvements, 26 October 2026

Local work on `feat/0.1.17-performance-local`. The 0.1.17 candidate remains
unpublished. No push, deployment, VPS modification or change to the existing
playground executable is part of this work.

The baseline is the complete source snapshot taken before this task, including
the pre-existing local changes. It is not the published 0.1.16 release and is not
a new comparison with Next.js. Evidence and reproducible measurement scripts
are under `artifacts/npm-next-improvements-20261026/` in this workspace.

## Implemented work

| # | Change | Behavior and validation |
| --- | --- | --- |
| 1 | Optional loader cache | Corrupt metadata, blocked storage and failed dependency snapshots become misses. Atomic publications and bounded eviction preserve real loader errors and `PRNEXT_BUILD_CACHE=0`. |
| 2 | SSR diagnosis | Ten fixed stages distinguish completion, failure, cancellation and timeout. Five resource budgets expose occupancy, peaks and rejections. Inspect JSON and local OTLP remain additive; timings overlap and contain no request body/header/query labels. |
| 3 | Queue and HTTP deadlines | `PRNEXT_QUEUE_WAIT_MS` defaults to 30,000. `PRNEXT_REQUEST_TIMEOUT_MS` defaults to zero (disabled). The optional absolute deadline spans middleware, uploads, worker work and response consumption, including unpolled streams. Completed responses preserve tracked `after()` work. |
| 4 | Reusable Webpack compilers | Stable virtual sources and current callbacks retain a real Compiler. Configuration, environment and plugin identity invalidate sessions. Six-session LRU, 64-build recycling, bounded Webpack cache and explicit disposal limit retention. Production stays one-shot. |
| 5 | Selective CSS publication | Per-bundle provenance selects affected bundles, learns new imports and removes old bundle edges. Unrelated CSS URLs and files stay unchanged. CSS Module mapping changes fall back to full compilation. Image/font URLs and immutable previous artifacts are tested. Unrelated Sass no longer disables a plain CSS update. |
| 6 | Scalable HMR graph | Interned file IDs cross the native control channel in frames below 64 KiB. Begin/chunks/commit preserve the active index until a full replacement validates. Rust handles deep cyclic traversal without a fixed depth cutoff. Capacity failures are reported and force complete refreshes. UTF-8 notification JSON is checked against its final byte size. |
| 7 | Installation checks | `prnext check` collects actionable config, route, React, TypeScript, Node and native executable diagnostics without executing the native binary, installing packages or building the app. |
| 8 | Independent type commands | `typegen` and `typecheck` discover routes without an app build. They respect custom/inherited JSONC tsconfigs and report updates. Explicit typecheck fails errors despite build opt-out; even an empty generated page registry rejects invalid internal links. |
| 9 | Manager-aware migration | npm, pnpm and Yarn Classic/Berry use their owning workspace root and lockfile. Dry runs report the actual command. Backups/rollback, concurrent-edit guards, symlink checks and preservation of unrelated workspace manifests protect existing projects. |
| 10 | Analysis regression gates | Explicit baseline files, raw/gzip/Brotli metrics, exact-route budgets and byte/percentage growth limits support CI. New routes cannot silently pass a missing comparison. Exit statuses distinguish success (0), budget failure (1) and invalid input (2). |

## Scope of verification

Windows x64 with Node 24.22.1. The candidate native executable is built with
the normal optimized release profile in an isolated target directory and copied
to `artifacts/npm-next-improvements-20261026/prnext-candidate.exe`.
`target/release/prnext.exe` and the existing previews on 3002, 3003 and 3017
are preserved.

Real HTTP checks exercise pre-header 504s, interrupted uploads, stream deadlines,
host reuse, cancellation, post-response work and inspect privacy. The native
graph check transfers 12,000 files through the real stdio listener, verifies
atomic failure, replacement and conservative response-size fallback.

Browser checks cover repeated CSS edits, unchanged worker PID and React state,
fresh navigation, class-map reversions, unrelated CSS URLs, unopened routes,
safe mode, CommonJS and actual Webpack graph updates.

| Validation | Result |
| --- | --- |
| Main JavaScript suite, fresh native candidate | 934 passed, 5 opt-in/platform skips, 0 failed |
| Rust workspace, final native source | 197 passed, 1 manual ignore, 0 failed |
| Complete integration suite (78 files) | 346 passed, 7 platform skips, 0 failed |
| Chromium development/compatibility scenarios | 13 passed; the 3 Webpack scenarios also passed again after the final fingerprint fix |
| Final cache/Webpack/incremental regressions | 27 passed, including 65 generations and mutated native option data |
| Final CSS/graph/notification regressions | 12 passed, including unrelated Sass, shared imports, assets and UTF-8 limits |
| Final diagnostics/types/migration/analysis regressions | 52 passed, 4 opt-in skips; 8 real-manager checks passed separately |
| TypeScript projects | tests/types, examples/basic and examples/app passed |
| Package preparation | Local release checks and npm pack dry run passed; all new modules included |

The first broad JS pass used the old default executable and failed the two
native development fixtures. That pass is retained as `unit-tests.log`; it is
not the final result. `unit-final.log` explicitly selects the fresh candidate and
passes both fixtures. Later targeted suites cover the final source changes.

Package-manager fixtures use isolated caches/stores and local dependencies.
They do not establish that an unpublished npm/native package family can already
be installed from the public registry. Linux/macOS/ARM64 validation and the
required GitHub checks remain part of release preparation.
An additional real Yarn 4 tarball test checks native extraction: a file without
an extension remains in the ZIP without package conditions, while the same
payload is extracted with `os` + `cpu`. Every generated PRNext native manifest
already declares those fields. This extraction check is distinct from executing
the complete published native family; see `yarn-native-pnp-audit.json`.

## Performance interpretation

Measured after the test/build workloads finished, on this Windows x64 Ryzen
5 3600 machine with Node 24.22.1. No background compiler or test suite overlapped
these measurements. Other applications and OS scheduling are not controlled.

| Local workload | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| CSS-only publication, median of 10 edited builds | 342.4 ms | 183.9 ms | 46.3% less elapsed time on 18 independent route CSS Modules |
| Webpack edited rebuild, median of three round medians | 394.8 ms | 382.5 ms | Small 3.1% difference; do not generalize this as a speed guarantee |
| Sequential dynamic Pages SSR, median of three p95 values | 1.215 ms | 0.916 ms | Tiny smoke workload with substantial variation; no general SSR speedup claim |

CSS uses four fresh-process rounds in before/after/after/before order, five
single-module edits per round, 18 bundles and 120 rules per module. Only the
affected bundle is recompiled in the new path; snapshot/publication overhead is
still included. The individual after samples range from 138.7 to 294.1 ms.

Webpack uses three alternating fresh-process rounds per variant, 120 modules,
one initial build and five edited rebuilds per round. Every after round records
one actual Compiler creation and five reuses. Earlier runs overlapping other
workloads are discarded; `webpack-rebuild-benchmark.json` contains the final
non-overlapping run and source SHA256 values.

SSR uses one unchanged immutable build, one worker, the balanced profile,
50 warmup requests and 400 measured responses per round. All 2,400 measured
responses pass status, dynamic freshness and alternating-cookie checks.
Before p95 varies from 0.808 to 1.441 ms, after from 0.863 to 0.994 ms. These
values cannot be compared to the earlier VPS/Next.js numbers. No production
response cache was added and no memory/throughput gain is claimed here.

Webpack Compiler reuse is demonstrated by counters and output behavior, including
65 consecutive real generations and recycling. Framework transform callbacks
still execute every build to preserve discovery side effects. These local
measurements do not establish a general speed benefit; session reuse alone is
not a performance claim.
Opaque recreated or mutated plugins deliberately permit conservative misses.
Map, Set, dates and binary views have explicit value fingerprints. Weak or
unobservable configuration data uses a fresh compiler. Replace a plugin instance
when its unchanged function captures changing external state that the
configuration does not expose.

CSS measurements use independent route styles and single-module edits. They
measure the CSS publication path, not an end-to-end browser refresh or arbitrary
application builds. SSR measurements use identical immutable
application artifacts and alternate only the optimized native binary with
instrumentation and the optional timeout disabled.

Bounded graph accounting is not a hard total RSS limit. Node/V8, HTTP/kernel
buffers and application allocations remain outside these counters. Failed
dependency installation may leave manager caches or node_modules partly updated;
metadata rollback does not pretend to undo those directories. An abrupt compiler
kill can leave a temporary `.prnext-webpack-*` directory until later cleanup.
