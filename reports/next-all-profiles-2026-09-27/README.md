# PRNext and Next.js — all runtime profiles

Measured September 27, 2026, on Apple M4 against Next.js 15.5.12. Three six-second runs per scenario, identical application sources, 105 functional parity checks, and 476,612 validated responses with zero errors. Ranges span four instrumented SSR/streaming scenarios; they are not an overall average or guaranteed gains.

| Metric | PRNext `balanced` | PRNext `speed` | PRNext `memory` | PRNext `classic` |
| --- | ---: | ---: | ---: | ---: |
| Memory under load | 26–66% lower | 35% lower to 5% higher | 27–70% lower | 2–50% lower |
| CPU time per response | 10–68% lower | 22–74% lower | 10–62% lower | 21–74% lower |
| Throughput | 1.00–4.15× | 1.00–5.33× | 0.54–3.80× | 1.00–5.28× |

Under concurrent streaming, `memory` used 179 MiB versus 207 MiB for `balanced`, but served 362 versus 726 responses/s. On concurrent SSR, it used slightly more memory than `balanced`. The lowest-memory profile is workload-dependent.

## Uncached SSR — 250 requested responses/s

| Engine | Responses/s | CPU load (% core) | CPU ms/response | RSS MiB | Latency p95 ms | TTFB p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Next.js | 250 | 60.2 | 2.407 | 181.5 | 2.78 | 2.14 |
| PRNext balanced | 250 | 39.8 | 1.593 | 128.8 | 1.56 | 1.39 |
| PRNext speed | 250 | 36.7 | 1.467 | 191.1 | 1.55 | 1.38 |
| PRNext memory | 250 | 40.2 | 1.607 | 128.3 | 1.47 | 1.32 |
| PRNext classic | 250 | 36.5 | 1.460 | 177.1 | 1.57 | 1.44 |

## Uncached SSR — 128 concurrent clients

| Engine | Responses/s | CPU load (% core) | CPU ms/response | RSS MiB | Latency p95 ms | TTFB p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Next.js | 952 | 156.7 | 1.650 | 467.7 | 158.26 | 91.76 |
| PRNext balanced | 3,948 | 211.5 | 0.535 | 159.8 | 45.09 | 45.06 |
| PRNext speed | 5,072 | 220.5 | 0.434 | 305.8 | 31.52 | 31.46 |
| PRNext memory | 3,621 | 227.1 | 0.627 | 162.0 | 46.84 | 46.80 |
| PRNext classic | 5,025 | 214.4 | 0.425 | 279.1 | 32.68 | 32.64 |

## Streaming + 40 ms local API — 250 requested responses/s

| Engine | Responses/s | CPU load (% core) | CPU ms/response | RSS MiB | Latency p95 ms | TTFB p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Next.js | 248 | 73.0 | 2.940 | 216.8 | 44.79 | 2.42 |
| PRNext balanced | 248 | 65.7 | 2.647 | 160.0 | 42.91 | 1.62 |
| PRNext speed | 248 | 56.6 | 2.280 | 208.1 | 42.76 | 1.61 |
| PRNext memory | 248 | 65.9 | 2.653 | 158.3 | 42.77 | 1.61 |
| PRNext classic | 248 | 57.6 | 2.320 | 195.3 | 42.83 | 1.55 |

## Streaming + 40 ms local API — 128 concurrent clients

| Engine | Responses/s | CPU load (% core) | CPU ms/response | RSS MiB | Latency p95 ms | TTFB p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Next.js | 673 | 163.9 | 2.442 | 605.1 | 229.55 | 122.79 |
| PRNext balanced | 726 | 123.9 | 1.704 | 207.4 | 180.89 | 140.34 |
| PRNext speed | 2,698 | 249.8 | 0.926 | 496.0 | 58.50 | 13.99 |
| PRNext memory | 362 | 74.8 | 2.067 | 178.7 | 358.38 | 317.66 |
| PRNext classic | 723 | 89.9 | 1.241 | 303.0 | 184.37 | 142.12 |

## Method and limits

- Apple M4, 10 cores, 16 GiB, macOS ARM64, Node.js 22.17.1. Next.js 15.5.12 in production with default settings. Application React 19.3.0; Next.js bundles React 19.2.0-canary-0bdb9206-20250818 internally.
- Fresh production builds from identical application sources. All PRNext profiles share one native binary and one application build. The profile is the only PRNext setting changed between configurations.
- Two workloads, each tested at 250 requested responses/s (up to 32 in flight) and at 128 concurrent clients. Three six-second repetitions. Profile order reverses every other repetition. Fresh server and 64 warmup requests before each measurement; execution counters reset after warmup.
- Every configuration proved 10,000 server executions for 10,000 identical uncached SSR requests. Timed requests were checked against render counters and backend calls: one backend call per streaming response and none for simple SSR. Status, application content, headers/cookies and compression contracts were checked before timing.
- RSS and CPU include the entire server process tree, including Rust, Node.js and RSC threads. Backend API and load generator are excluded. CPU load of 100% means one core. More throughput can require more total CPU even when CPU time per response is lower. RSS adds process resident memory; shared pages may be counted more than once.
- These are instrumented local microbenchmarks, including audit logging overhead, without TLS or a CDN. They are not endurance tests, VPS measurements or a guarantee for every application or operating system. No build or test suite ran alongside the timed requests. Ordinary desktop applications remained open. No thermal/performance warning was reported before or after the campaign.
- No load-generator run crossed the recorded 85% CPU threshold. The CSV includes cold/warm idle memory, peak memory, p50/p95/p99, TTFB, compressed response sizes and backend calls/s. The summary includes median, minimum and maximum across repetitions.
- Flight and Server Actions remain PRNext-specific adaptations. They passed functional checks but were not timed as direct wire-protocol comparisons.
- At 128 concurrent streaming clients, memory used 14% less RAM than balanced but about half its throughput, and its p95 first-byte latency was 317.66 ms versus 122.79 ms for Next.js. Balanced also had higher first-byte latency than Next.js on that workload (140.34 ms). Speed used about 5% more RAM than Next.js on fixed-rate SSR. These tradeoffs are included in the reported ranges.

## Data and verification

[Interactive report](index.html) · [CSV](metrics.csv) · [Raw measurements](results.json) · [Medians and variation](summary.json) · [Method and source hashes](method.json) · [Verification](verification.json) · [Build preparation](preparation.json)

Per-configuration parity evidence and 10,000-render logs are preserved in the `parity-next`, `parity-balanced`, `parity-speed`, `parity-memory` and `parity-classic` directories. Their internal identifiers remain unchanged to preserve the recorded evidence.

## Reproduce

Run from the repository root with the pinned reference dependencies available; see the [dynamic benchmark protocol](../../scripts/dynamic-benchmark/README.md). Use a fresh output directory. The prepare step builds both engines from the current common fixture, then validates each selected profile before timing.

```sh
npm run build:native
export RESOURCE_BENCH_OUTPUT=reports/next-all-profiles-new
export PROFILE_COMPARE_ENGINES=next,balanced,speed,memory,classic
export DYNAMIC_BENCH_REFERENCE=reports/dynamic-parity/projects/next
node scripts/compare-profile-modes.mjs prepare
node scripts/compare-profile-modes.mjs run
node scripts/compare-profile-modes.mjs report
```

Set `DYNAMIC_BENCH_REFERENCE` to the directory containing your pinned Next.js installation if it differs. The native build and benchmark tools are unchanged during a campaign; the source and artifact hashes identify this run.
