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

| Metric | PRNext `balanced` | PRNext `speed` |
| --- | ---: | ---: |
| Memory under load | **28–66% lower** | 36% lower to 6% higher |
| CPU time per response | **9–67% lower** | **20–73% lower** |
| Throughput | **1.0–4.05×** | **1.0–5.19×** |

Measured September 24, 2026, on Apple M4 against Next.js 15.5.12. Three six-second runs per scenario, identical application sources, functional parity checks, and 280,184 validated responses with zero errors. These ranges summarize the measured scenarios, not an overall average. Results vary by workload. See the [benchmark details and data](docs/benchmarks.md).

🧪 **Very early alpha — 0.1.0-alpha.1.** Next.js compatibility is still partial. This release is intended for experimentation and feedback, not production applications. Testing, feedback, and contributions are welcome.

[Compatibility](docs/compatibility.md) · [Runtime profiles](docs/runtime-profiles.md) · [Migration guide](docs/import-next.md) · [Development guide (French)](docs/development.fr.md)
