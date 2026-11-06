# Node runtime qualification

PRNext accepts supported Node 22, 24 and 26 releases according to its package
`engines` range. The main platform matrix continues to use Node 22.23.4, and the
release endurance workflow continues to use Node 24.22.1. Adding Node 26 coverage
does not change a deployment's selected Node executable or its production default.

The Linux CI job adds four required Node **26.13.0** suites using the same native
artifact built by the existing Linux job:

| Suite | Evidence |
| --- | --- |
| Runtime | RSC/Flight, HTML rendering, warm-up, streams, cache isolation, compile-cache and source-summary/native-discovery tests; real HTTP SSR, streams, cache, readiness and Flight diagnostics tests |
| Browser | Chromium hydration, progressive streams, Flight delta, ISR, partial rendering and deployment coherence |
| Independent SaaS | A separately installed consumer with owned PostgreSQL, HTTPS, authentication, navigation and SQL reads/writes |
| Package | Actual framework/native TGZ installation with hoisted and nested dependencies, followed by the existing packaged lifecycle suite |

Each suite writes a progressive receipt under `artifacts/node26-qualification/`
with its exact Node/native SHA-256, source commit, lockfile hash, selected test
hashes and command outcomes. A failed or interrupted suite does not produce a
passing receipt. These jobs belong to the existing reusable platform workflow,
so the main `CI result` requires them alongside the original platform tests.
The complete Node 22 matrix and the existing Node 22/24/26 package-release checks
remain in place. The new Chromium selection is additional coverage; it does not
qualify every browser engine under Node 26.

Before claiming a source qualified, inspect the successful CI result and all four
receipts for that final commit. Local plan tests and short Windows throughput
observations do not establish Linux, packaged-consumer or SaaS compatibility.

## Controlled Node 24 versus Node 26 measurements

The **Controlled Node runtime performance** reusable workflow compares
Node 24.22.1 and 26.13.0 at one clean source commit. It builds the native once,
verifies the same framework/native archive bytes in both independent consumers,
requires matching normalized installed dependency lock graphs, and records each
server Node executable's exact path, version and digest. The build and load
generator both run under Node 24.22.1. Only server Node changes between variants.

The existing controlled harness retains its 72 adjacent route windows, 12 paired
repetitions, 15-second measurements, two workers, CPU quota of two CPUs, fixed
kernel affinity, 5 GiB memory limit and server-only cgroup accounting. Its
throughput, p95, noise and generator CPU budgets are unchanged. A missing resource
proof, mismatched Node window, dependency graph drift or incomplete cleanup
invalidates the comparison. Configuration, preparation, archives, samples and
the kernel preflight are retained on failure as well as success.

Before this new workflow is present on the default branch, manually dispatch the
existing **Controlled candidate performance** workflow on the candidate branch
with `compare_node26: true`. It calls the Node comparison from the same commit;
the ordinary source comparison is skipped for that invocation. The Boolean
defaults to `false`, so existing PR-label and source-comparison behavior stays
unchanged. Node comparison remains an explicit manual run, not extra load on
every pull request. Once available on the default branch, the dedicated workflow
can also be dispatched directly.

Results describe the declared SSR/API/stream fixtures and concurrency. Shared
host contention, namespace-hidden resource limits, compilation caches and short
measurement windows still limit generalization. This is not a browser hydration,
long-duration SaaS or universal Node-version ranking. Adopt a production runtime
only after its application and operational checks pass; benchmark gains alone
do not establish compatibility.

For a non-writing view of a CI suite:

```sh
node scripts/ci-node26.mjs --suite runtime --list
```

To prepare the controlled comparison on an already built, clean Linux checkout
under Node 24.22.1, without starting the load:

```sh
node tests/performance/prepare-node-comparison.mjs /absolute/path/to/node26 artifacts/new-node-comparison 0,1
```

Preparation installs dedicated consumers from the public npm registry; it is not
an offline command. The workflow performs the kernel preflight before preparation
and runs the load only in the verified resource scope. It never publishes npm.
