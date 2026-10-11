# Linux v5 campaign — prepared, not executed

This campaign compares the frozen **final v4 source state** with the future v5
candidate from the current checkout. It does not compare v5 with commit
`63847087826f178de3a32f165231b20b6c66b92e` alone: v4 includes later uncommitted
changes. The v4 reference lives in `artifacts/performance-v5/reference-v4`;
`reference.json` records the complete source-file SHA-256 map and tree digest.

The v4 scripts and evidence remain unchanged. Linux, cgroup/PSS, Nginx and
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

Next **16.3.5**, React **19.3.0** and application dependencies come from the
existing pinned fixture lock. Both native builds use their own unchanged
Cargo/npm lockfiles. Nginx, wrk, kernel, CPU topology, Python patch version,
compiler, executable hashes and source hashes are recorded on the actual
runner; those platform-specific versions are not claimed before execution.

The baseline input is either a fresh full `source/` directory with sibling
`reference.json`, or a local `reference-v4-source.tar.gz` archive produced from
that snapshot with its independently supplied SHA-256. The final archive is
prepared separately when the candidate is frozen; this document does not claim
that an archive has already been generated or validated. Archive extraction
rejects links, traversal, duplicate entries and unexpected roots. Preparation
requires `baseline: final-v4`, verifies every recorded file and tree digest,
and rejects unrecorded source files. A partial runtime copy or Git revision
is insufficient.

```sh
# From the v5 candidate checkout. Use new output paths for every attempt.
python3 tests/performance/linux-prepare-v5.py \
  --baseline-archive /local/reference-v4-source.tar.gz \
  --baseline-sha256 SHA256 \
  --output /local/prnext-linux-v5

# Alternative: --baseline-source /local/reference-v4/source
# with /local/reference-v4/reference.json alongside it.

export PRNEXT_BINARY=/local/prnext-linux-v5/prnext-candidate
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace -- --test-threads=1
npm run test:unit
npm run test:types
npm run test:e2e

python3 tests/performance/linux-campaign-v5.py \
  --prepared /local/prnext-linux-v5 \
  --cgroup-root /delegated/empty-parent
```

The manual workflow `.github/workflows/performance-linux-v5.yml` runs this
sequence on a `self-hosted, linux, prnext-performance` runner and retains raw
results and failures. Its inputs are passed through quoted environment
variables, not inserted into shell program text. Merely adding this workflow
does not dispatch it. Do not modify the checkout during preparation or tests;
preparation verifies that recorded source files remain unchanged after builds.

## Comparisons and compatibility

Labels are `v4-*`, `candidate-*`, `next` and `nginx`. Each native version builds
the same application sources with its own compiler. For static performance,
**both native binaries and Nginx serve the exact same candidate build bytes**,
including existing gzip sidecars and timestamps. Public files use identity
encoding because Nginx runtime gzip is disabled. Wire-byte controls precede
throughput and cover HEAD, range/If-Range and cache validation.

V4 and v5 share the runtime contract. The old v3-artifact rejection assertion
has therefore been removed from v5 preparation. A separate functional run,
`functional-candidate-v4-build`, verifies that the candidate serves an actual
application compiled from the frozen v4 sources, including freshness,
streaming and cancellation. It is not a throughput sample. Older incompatible
v3-artifact rejection remains covered by its existing tests.

The campaign retains three alternating 30-second dynamic/static rounds,
60 seconds without HTTP/TCP readiness probes for every native profile/version,
one hour of mixed traffic on **each** native version, three actual 1/5/15-minute
idle cycles per profile/version, and two simultaneous instances. Both v4 and
candidate diagnostic soaks enable the same native metrics observer; ordinary
throughput comparisons do not enable it. Startup/idle pairs share a physical
core with staggered traffic, as in the v4 methodology; generator and server
CPU sets are disjoint. Each server subtree has a 1-CPU cgroup budget, 2 GiB
memory limit and zero swap when the controller exposes it.

`linux-runner.py` is reused unchanged. Its CPU accounting includes terminated
workers; RSS/PSS/FD/process sampling can miss short-lived processes and is not
an exhaustive process-creation counter. Dynamic requests are drained. Static
wrk closes remaining requests at the boundary, leaving those cancellations
uncounted; they are not silently converted into completed successes. Generator
thread CPU above 85% flags a possible client bottleneck. Every failed command
leaves the campaign incomplete. The unchanged runner and v4 methodology remain
the source of these measurement limits, not a claim of a successful Linux run.
