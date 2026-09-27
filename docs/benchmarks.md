# PRNext benchmarks

Measured September 27, 2026, on Apple M4 against Next.js 15.5.12. Three six-second runs per scenario, identical application sources, 105 functional parity checks, and 476,612 validated responses with zero errors. Ranges span four instrumented SSR/streaming scenarios; they are not an overall average or guaranteed gains.

| Metric | PRNext `balanced` | PRNext `speed` | PRNext `memory` | PRNext `classic` |
| --- | ---: | ---: | ---: | ---: |
| Memory under load | 26–66% lower | 35% lower to 5% higher | 27–70% lower | 2–50% lower |
| CPU time per response | 10–68% lower | 22–74% lower | 10–62% lower | 21–74% lower |
| Throughput | 1.00–4.15× | 1.00–5.33× | 0.54–3.80× | 1.00–5.28× |

Under concurrent streaming, `memory` used 179 MiB versus 207 MiB for `balanced`, but served 362 versus 726 responses/s. On concurrent SSR, it used slightly more memory than `balanced`. The lowest-memory profile is workload-dependent.

Each value compares the same scenario against Next.js, using the medians of three runs. The detailed report also exposes regressions and first-byte latency.

[Full report and methodology](../reports/next-all-profiles-2026-09-27/README.md) · [Interactive report](../reports/next-all-profiles-2026-09-27/index.html) · [Raw data](../reports/next-all-profiles-2026-09-27/results.json) · [CSV](../reports/next-all-profiles-2026-09-27/metrics.csv)

[Previous campaign, September 24](../reports/speed-next-balanced/summary.json). These campaigns remain separate; the current table uses only the September 27 measurements.
