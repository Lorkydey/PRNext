# PRNext

**Power your Next.js projects with Rust.**

A framework designed to reduce memory usage and improve performance while working with the React and npm ecosystem.

**Platforms:** macOS, supported Linux distributions, and Windows via WSL.

**CLI:** use `prnext` or its shortcut, `prn`.

## Get started

- Migrate your Next.js project: `prn migrate`
- Start development: `prn dev`
- Build for production: `prn build`
- Start production with the default balanced profile: `prn start`

For a local npm installation, prefix these commands with `npx --no-install`, for example `npx --no-install prn migrate`. Node.js 22+ is required. npm publication is pending; see the [package preparation guide](docs/publishing.md).

## Choose your runtime profile

- **Balanced:** `prn start --profile balanced` — balance memory, CPU, and response times.
- **Speed:** `prn start --profile speed` — prioritize throughput and responsiveness.
- **Memory:** `prn start --profile memory` — prioritize lower memory usage.
- **Classic:** `prn start --profile classic` — use the original runtime settings.

## Early benchmarks against Next.js

Observed ranges across four dynamic SSR and streaming scenarios:

| Metric | PRNext `balanced` | PRNext `speed` | PRNext `memory` | PRNext `classic` |
| --- | ---: | ---: | ---: | ---: |
| Memory under load | 26–66% lower | 35% lower to 5% higher | 27–70% lower | 2–50% lower |
| CPU time per response | 10–68% lower | 22–74% lower | 10–62% lower | 21–74% lower |
| Throughput | 1.00–4.15× | 1.00–5.33× | 0.54–3.80× | 1.00–5.28× |

Measured September 27, 2026, on Apple M4 against Next.js 15.5.12. Three six-second runs per scenario, identical application sources, 105 functional parity checks, and 476,612 validated responses with zero errors. Ranges span four instrumented SSR/streaming scenarios; they are not an overall average or guaranteed gains. See the [benchmark details and data](docs/benchmarks.md).

Under concurrent streaming, `memory` used 179 MiB versus 207 MiB for `balanced`, but served 362 versus 726 responses/s. On concurrent SSR, it used slightly more memory than `balanced`. The lowest-memory profile is workload-dependent.

🧪 **Very early alpha — 0.1.0-alpha.1.** Next.js compatibility is still partial. This release is intended for experimentation and feedback, not production applications. Testing, feedback, and contributions are welcome.

[Compatibility](docs/compatibility.md) · [Runtime profiles](docs/runtime-profiles.md) · [Migration guide](docs/import-next.md) · [Development guide (French)](docs/development.fr.md)
