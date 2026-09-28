# PRNext

[Website](https://prnext.dev) · [GitHub](https://github.com/Lorkydey/PRNext) · [Report an issue](https://github.com/Lorkydey/PRNext/issues)

A framework designed to reduce memory usage and improve performance while working with the React and npm ecosystem.

**Platforms:** macOS, supported Linux distributions, and Windows via WSL.

**CLI:** use `prnext` or its shortcut, `prn`.

## Get started

- Migrate your Next.js project: `prn migrate`
- Start development: `prn dev`
- Build for production: `prn build`
- Start production with the default balanced profile: `prn start`

For a local npm installation, prefix these commands with `npx --no-install`, for example `npx --no-install prn migrate`. Node.js 22+ is required. npm publication is pending.

## Choose your runtime profile

- **Balanced:** `prn start --profile balanced` — balance memory, CPU, and response times.
- **Speed:** `prn start --profile speed` — prioritize throughput and responsiveness.
- **Memory:** `prn start --profile memory` — prioritize lower memory usage.
- **Classic:** `prn start --profile classic` — use the original runtime settings.

## Early benchmarks against Next.js

Dynamic streaming with 128 concurrent clients and a deterministic local backend delayed by 40 ms:

| Configuration | RAM | CPU load¹ | CPU/response | Throughput |
|---|---:|---:|---:|---:|
| Next.js | 605 MiB | 164% | 2.442 ms | 673 req/s |
| **Balanced** | **207 MiB** | 124% | 1.704 ms | 726 req/s |
| **Speed** | 496 MiB | 250% | **0.926 ms** | **2,698 req/s** |
| **Memory** | **179 MiB** | **75%** | 2.067 ms | 362 req/s |
| **Classic** | 303 MiB | 90% | 1.241 ms | 723 req/s |

¹ 100% CPU = one fully utilized CPU core. RAM is measured under load.

Measured September 27, 2026, on Apple M4 against Next.js 15.5.12. Values are medians of three six-second runs using identical application sources. This table covers one streaming scenario, not an overall average or guaranteed gains. Functional parity was checked before benchmarking.

Under concurrent streaming, `memory` used 179 MiB versus 207 MiB for `balanced`, but served 362 versus 726 responses/s. On concurrent SSR, it used slightly more memory than `balanced`. The lowest-memory profile is workload-dependent.

🧪 **Very early alpha — 0.1.0-alpha.1.** Next.js compatibility is still partial. This release is intended for experimentation and feedback, not production applications. Testing, feedback, and contributions are welcome.
