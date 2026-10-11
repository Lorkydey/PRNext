# Linux v6 campaign — prepared, not executed

This campaign compares the frozen **final v5 source state** with the v6
candidate from the current checkout. It does not compare v6 with commit
`63847087826f178de3a32f165231b20b6c66b92e` alone: v5 includes later uncommitted
changes. The v5 reference lives in `artifacts/performance-v6/reference-v5`;
`reference.json` records the complete source-file SHA-256 map and tree digest.
The Windows-tested candidate is frozen in `candidates/final-http`; its native
binary SHA-256 is `b5515bb7a50e4c39b790ccca7132f6d3c0096dd20dafed3d4497cc7b4cd252f6`.
Linux builds have different executable hashes, recorded during preparation.

The v5 scripts and evidence remain unchanged. Linux, cgroup/PSS, Nginx and
Unix-only runtime results remain **unverified until this campaign actually
finishes**. Local syntax, archive and configuration checks do not provide that
evidence. Nothing here runs on or modifies the TinyDigit VPS.

## Runner and inputs

Use an otherwise idle, dedicated Linux benchmark runner, never a production
host. Preinstall Node **24.19.0**, npm **11.12.1**, Rust **1.98.0** with rustfmt
and clippy, Python **3.12** (patch version recorded), native C/C++ build tools,
nasm, pkg-config, git, util-linux/taskset, wrk and Nginx with `gzip_static`.
The runner must expose five available physical cores and Linux cgroup v2.
Supply an empty writable cgroup parent with CPU and memory controllers already
delegated. The scripts do not install packages, enable controllers, change an
existing service, change system Nginx configuration or publish anything.

Under WSL2, put the checkout, extracted v5 sources, dependencies, builds and
measurement output in the Linux filesystem (for example under `/home`), not
`/mnt/c`. Preparation records `findmnt` filesystem types and rejects Windows
and 9p shared mounts. The input archive may be read from a Windows drive before
extraction; served files and runtime sources must reside on Linux storage.
WSL CPU scheduling and virtualization remain platform limits to document in
the actual results; this check does not make WSL equivalent to a native VPS.

Next **16.3.5**, React **19.3.0** and application dependencies come from the
existing pinned fixture lock. Both native builds use their own unchanged
Cargo/npm lockfiles. Nginx, wrk, kernel, CPU topology, Python patch version,
compiler, executable hashes and source hashes are recorded on the actual
runner; those platform-specific versions are not claimed before execution.

The baseline input is either a fresh full `source/` directory with sibling
`reference.json`, or a local `reference-v5-source.tar.gz` archive produced from
that snapshot with its independently supplied SHA-256. The prepared archive and
verified hash are listed below. Archive extraction
rejects links, traversal, duplicate entries and unexpected roots. Preparation
requires `baseline: final-v5`, verifies every recorded file and tree digest,
and rejects unrecorded source files. A partial runtime copy or Git revision
is insufficient.

```sh
# From the v6 candidate checkout. Use new output paths for every attempt.
python3 tests/performance/linux-prepare-v6.py \
  --baseline-archive /local/reference-v5-source.tar.gz \
  --baseline-sha256 SHA256 \
  --output /local/prnext-linux-v6

# Alternative: --baseline-source /local/reference-v5/source
# with /local/reference-v5/reference.json alongside it.

export PRNEXT_BINARY=/local/prnext-linux-v6/prnext-candidate
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace -- --test-threads=1
npm run test:unit
npm run test:types
npm run test:e2e

python3 tests/performance/linux-campaign-v6.py \
  --prepared /local/prnext-linux-v6 \
  --cgroup-root /delegated/empty-parent
```

The manual workflow `.github/workflows/performance-linux-v6.yml` runs this
sequence on a `self-hosted, linux, prnext-performance` runner and retains raw
results and failures. Its inputs are passed through quoted environment
variables, not inserted into shell program text. Merely adding this workflow
does not dispatch it. Do not modify the checkout during preparation or tests;
preparation verifies that recorded source files remain unchanged after builds.

## Comparisons and compatibility

Labels are `v5-*`, `candidate-*`, `next` and `nginx`. Each native version builds
the same application sources with its own compiler. For static performance,
**both native binaries and Nginx serve the exact same candidate build bytes**,
including existing gzip sidecars and timestamps. Public files use identity
encoding because Nginx runtime gzip is disabled. Wire-byte controls precede
throughput and cover HEAD, range/If-Range and cache validation.

V5 and v6 share the runtime contract. The old v3-artifact rejection assertion
has therefore been removed from v6 preparation. A separate functional run,
`functional-candidate-v5-build`, verifies that the candidate serves an actual
application compiled from the frozen v5 sources, including freshness,
streaming and cancellation. It is not a throughput sample. Older incompatible
v3-artifact rejection remains covered by its existing tests.

The campaign retains three alternating 30-second dynamic/static rounds,
60 seconds without HTTP/TCP readiness probes for every native profile/version,
one hour of mixed traffic on **each** native version, actual 1/5/15-minute
idle periods per profile/version, and two simultaneous instances. Use
`--idle-cycles 3` for three repetitions of every rest duration; the default is
one complete cycle so the full sequential workflow fits its time budget.
Both v5 and
candidate diagnostic soaks enable the same native metrics observer; ordinary
throughput comparisons do not enable it. Zero-traffic startup observations can
share a physical core because they send no requests; loaded idle/wake cycles run
sequentially. Generator and server CPU sets are disjoint. Each server subtree
has a 1-CPU cgroup budget, 2 GiB
memory limit and zero swap when the controller exposes it.

`linux-runner.py` is reused unchanged. Its CPU accounting includes terminated
workers; RSS/PSS/FD/process sampling can miss short-lived processes and is not
an exhaustive process-creation counter. Dynamic requests are drained. Static
wrk closes remaining requests at the boundary, leaving those cancellations
uncounted; they are not silently converted into completed successes. Generator
thread CPU above 85% flags a possible client bottleneck. Every failed command
leaves the campaign incomplete. The unchanged runner and v5 methodology remain
the source of these measurement limits, not a claim of a successful Linux run.

## V6 additions and current execution status

This protocol has NOT run on Linux. The Windows host has no installed WSL,
Docker or Podman. No production VPS is used. Python syntax and the immutable
780-file v5 reference map have been checked locally; these are preparation checks.

The frozen archive is `artifacts/performance-v6/reference-v5-source.tar.gz`,
SHA-256 `4d8a2f5cc7bc6f25038cb8ac1920a53f01253f54b331d2f9244b5e185cc9ffd7`.
Use the current v6 checkout as candidate; preserve its exact source hashes.

After `linux-campaign-v6.py`, run `linux-multi-v6.py --prepared PATH
--cgroup-root DELEGATED_PARENT`. This creates 8 independent application roots
on the Linux filesystem, sharing only read-only dependencies. Each measurement
places all selected applications and its idle supervisor in ONE cgroup with
one CPU and 512 MiB, 1 GiB or 2 GiB. `memory.swap.max=0` is required.
It compares v5/candidate and balanced/memory/speed plus balanced with explicit
`NODE_OPTIONS=--max-semi-space-size=1` (label `balanced-small`). This is an existing
configuration override, not a new profile, and does not reproduce all effects
of the old `--optimize-for-size` policy. Node rejects that latter flag in
`NODE_OPTIONS`; the initial invalid Windows attempts are retained and excluded.
Two repetitions reverse variant order.
All-active, one-active and noisy-neighbour phases report each application's
validated useful throughput and p50/p95/p99; HTTP errors/503, cgroup memory events,
RSS/PSS, descriptors, threads, and cumulative exited-process CPU remain in raw
results. Failed and OOM runs are retained. A failed run cannot justify a gain.

Idle/wake campaigns run sequentially to avoid sharing a loaded generator. The
workflow has a 12-hour ceiling; choose an idle dedicated runner and retain failures
on timeout. Nginx remains private to the test prefix and serves the identical
candidate HTML/gzip bytes. The workflow neither installs system packages nor
enables controllers or changes production services. Unix symlinks, path safety,
cache, signals, process shutdown and rebuild cases run in the complete native
and E2E suites. Those results remain pending until actual Linux execution.
