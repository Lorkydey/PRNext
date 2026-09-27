# Dynamic parity benchmark

This benchmark fails closed: performance rows are comparable only after both
engines pass the same application, HTTP and execution-path checks. A matching
HTML fragment alone never establishes equivalence.

The application is defined once in `fixture.mjs`; it imports `next/*`, never
`prnext/*`, and contains no engine detection. The fixture is copied to two
isolated projects. Builds and benchmark servers do not modify the user's blog.

## Reproduce from a PRNext checkout

Requirements: Node 22, Rust toolchain, Chromium for Playwright, macOS or Linux
with `ps`. The recorded campaign uses macOS/M4. Install the repository's locked
dependencies and compile the native release binary:

```sh
npm ci
npm run build:native
npx playwright install chromium
npm run test:bench-dynamic

mkdir -p reports/dynamic-parity/projects/reference
npm install --prefix reports/dynamic-parity/projects/reference --no-audit --no-fund \
  next@15.5.12 react@19.3.0 react-dom@19.3.0 scheduler@0.28.0

DYNAMIC_BENCH_REFERENCE=reports/dynamic-parity/projects/reference npm run bench:dynamic
npm run bench:dynamic:report
```

The fixture also uses the repository's `react-server-dom-webpack` dependency.
Installed package versions, native binary SHA-256 and fixture SHA-256 are
recorded. Do not compare different dependency versions as one campaign.

For the local workspace, the default reference installation is the sibling
`nextjs-test-blog` directory; `DYNAMIC_BENCH_REFERENCE` overrides it. It is used
only to resolve already-installed packages, not as application source.

Options:

```sh
# Verify parity only; no comparative performance measurement.
node scripts/dynamic-benchmark/runner.mjs --reuse-build --parity-only

# Continue an interrupted campaign with the same fixture and native binary.
node scripts/dynamic-benchmark/runner.mjs --reuse-build --resume

# Keep separate campaigns in different directories.
DYNAMIC_BENCH_OUTPUT=reports/dynamic-parity-other npm run bench:dynamic
```

`--reuse-build` requires a successful previous preparation. Without it, both
frameworks are built before testing. The recorded build times are preparation
metadata, not a repeated build-performance comparison.

## What is audited

- `/ssr`: `force-dynamic`, `revalidate=0`, no data cache, no pre-rendered route.
  The function performs fixed CPU work and appends an execution record. A
  mandatory check sends 10,000 identical requests and requires 10,000 records.
- `/products/[id]`: awaited `params` and `searchParams`, repeated query fields,
  request headers, cookie session, and the exact arguments written to the log.
- `/data`: one deterministic, uncached backend read for every server render.
- `/api/products/[id]` and `/api/pages`: GET and POST JSON, query/header/cookie
  inputs, nested request body, 200/201 status, response header and Set-Cookie.
  A fixed 32-item catalogue makes both Pages API implementations return gzip,
  avoiding Next's threshold for tiny JSON. Next Route Handlers still return
  identity in this fixture: their comparable performance profile explicitly
  requests identity on BOTH engines. The small invalidation acknowledgement
  is also requested with identity encoding on both engines. Default gzip
  negotiation is a separate diagnostic, not a directly comparable workload.
- `/session`: alice, bob and missing cookie produce different expected results.
- `/cache`: **dynamic HTML with a data cache**, not an ISR HTML-cache hit.
  Hit, miss and invalidation are separate execution paths. A mutation test
  proves stale data remains cached before explicit invalidation.
- A measured revalidation cycle is four HTTP responses: cold miss, hit, POST
  invalidation, new miss. Exactly three renders and two backend reads occur.
  Cycles run with concurrency 1 because `revalidatePath('/cache')` invalidates
  the common page path; otherwise cycles can invalidate one another.
- `/redirect` and `/missing`: HTTP contract, destination, noindex, initial
  server HTML and the final browser-rendered result are recorded separately.
- Flight is consumed by each engine's real browser client. Navigation must
  remain in the same document and reflect changed cookies and headers. The
  application function must execute again. Engine-specific router envelopes
  are explicitly classified as emulation, not wire-level compatibility.
- Server Actions use the real browser POST, return value and cookie, mutate
  the backend once and refresh the displayed cache value. The complete
  execution traces and backend call counts must also match to be comparable.
- Streaming/Suspense uses the same component and 40 ms backend delay. An
  additional test blocks the backend indefinitely until the shell has arrived,
  for both identity and gzip. The final browser content must match.

Every measured response validates status, Content-Encoding, significant headers/cookies and the
complete application JSON. Every measured run also validates the exact
function arguments and backend keys/tenants, including cache-cycle order.

## Measurement and limits

Each scenario runs three paired repetitions, alternating Next/PRNext order.
The 250 HTTP responses/s profile compares equal work rates. The other profile
uses concurrency 32 (1 for compound invalidation cycles) for observed
throughput. Servers are restarted and persisted data caches removed before
each run. Hits are primed before measurement; counters are reset after warmup.

Memory and CPU include the entire server process tree, including lazy Node
and RSC workers. The local backend and load generator are separate processes;
their CPU/RAM or CPU use are recorded separately. Both run on the same host,
so client or backend saturation can limit observed server throughput. RSS is
sampled, includes shared pages per process and excludes OS-wide disk caches.

Instrumentation uses synchronous append-only JSON records, without fsync per
event. Its CPU/I/O cost is included. These are **instrumented microbenchmarks**,
not uninstrumented production capacity or an endurance test.

Latency is per HTTP response; the compound scenario additionally records
cycles/s and cycle p95. TTFB means first received encoded body byte. Response
size is actual wire body bytes, excluding headers; content encodings and
decoded sizes are retained. Latency samples are sorted within each run;
reported scenario values are medians of three run-level statistics.

The report excludes entire pairs lacking three valid runs for **each** engine.
Failed runs remain in raw results; they are not silently averaged away. Flight
and Actions are never presented as direct comparisons of the Next wire
protocol. Output differences and execution-path differences are separate.

## Files

- `benchmark-results.html`: self-contained report and interactive charts.
- `benchmark-results.md`: reviewable text report.
- `metrics.csv`: semicolon-delimited, UTF-8 BOM, for spreadsheets.
- `results.json`: all runs and parity evidence.
- `parity.json`: standalone checks, response bodies, raw HTTP headers, traces.
- `summary.json`: medians plus min/max values for every metric.
- `next-ssr-10000.ndjson`, `rustyx-ssr-10000.ndjson`: per-execution proof logs. The internal `rustyx` engine ID is retained for compatibility with historical evidence; the framework is now named PRNext.
- `integrity.json`: source/artifact hashes checked at the end of the campaign.

The test fixture deliberately exposes unauthenticated mutation/invalidation
routes on loopback. It is a benchmark, not an application to deploy publicly.

Official references: [dynamic rendering](https://nextjs.org/docs/15/app/api-reference/file-conventions/route-segment-config),
[unstable_cache](https://nextjs.org/docs/15/app/api-reference/functions/unstable_cache),
[revalidateTag](https://nextjs.org/docs/15/app/api-reference/functions/revalidateTag),
[redirect](https://nextjs.org/docs/15/app/api-reference/functions/redirect).
