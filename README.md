<a href="https://prnext.dev"><img src="https://prnext.dev/favicon.svg" alt="PRNext logo" width="80" height="80"></a>

# PRNext

[Website](https://prnext.dev) · [GitHub](https://github.com/Lorkydey/PRNext) · [Report an issue](https://github.com/Lorkydey/PRNext/issues)

A framework designed to reduce memory usage and improve performance while working with the React and npm ecosystem.

**Platforms:** Windows (native, no WSL), macOS, and Linux glibc, on x64 and arm64.

**CLI:** use `prnext` or its shortcut, `prn`.

## Get started

```sh
npm install @thomas.f/prnext@alpha
```

- Migrate your Next.js project: `prn migrate`
- Start development: `prn dev`
- Build for production: `prn build`
- Start production with the default balanced profile: `prn start`

For a local npm installation, prefix these commands with `npx --no-install`, for example `npx --no-install prn migrate`. Node.js 22+ is required.

## Develop from this repository

Install Node.js 22+ and Rust with rustup, then run:

```sh
npm ci
npm run build:native
npm run dev -- examples/app
```

These commands also work in PowerShell and Command Prompt. On Windows, source builds require Visual Studio Build Tools with the Desktop development with C++ workload and a Windows SDK, plus NASM on x64. Rustup selects the repository's Rust 1.98 toolchain. Linux source builds need a C/C++ toolchain, NASM and pkg-config; macOS needs Xcode command line tools and NASM.

For production locally, run `npm run build -- examples/app`, then `npm run start -- examples/app`. Standalone output runs with `node server.js` on its build OS and architecture, including Windows. Published native packages remove the Rust/C++ build requirement for consumers; the Windows packages added here must be built, verified and published with the corresponding framework release before a registry installation can use them.

## Check a migration before switching

```sh
prn migrate ./my-app --check
prn migrate ./my-app --check --json
prn migrate ./my-app --check --against http://localhost:3000 --candidate http://localhost:3001 --routes paths.json
```

The source audit reports unsupported Next imports with file and line numbers, client/server import conflicts, dependency versions and scripts requiring manual changes. It leaves sources, package files and builds untouched. Configuration files are evaluated by the existing preflight; installed dependencies and custom loaders still require a build. Warnings are distinct from blocking errors. A failed audit or response comparison exits with code 1.

For comparison, start the existing Next application and the PRNext candidate separately. `paths.json` is a JSON array such as `["/", "/products/123", "/api/catalog"]`; without it, the command selects non-parameterized page routes from the audit. It sends GET requests without authentication, follows no redirects, and compares status, content type, redirect destinations and bodies. JSON object key order is ignored; HTML compares text with scripts/styles removed. This verifies response samples, not hydration, styling, interactive behavior or every dynamic path. Timing observations are not controlled performance benchmarks. `--timeout 10000` sets each response's deadline in milliseconds.

## Inspect routes, cache and timings

```sh
prn build ./my-app
prn start ./my-app --inspect
# In another terminal, after visiting the application:
prn inspect ./my-app
prn inspect ./my-app --json
```

The inspector explains static, dynamic and partially prerendered routes using build metadata, including observed App prerendering bailouts and Pages data hooks. Opt-in measurements show native HTTP timings, fetch destinations and timings, native data cache hits/misses/stale reads, bypass reasons and successful tag/path invalidations. A custom cache handler is identified as a delegation; its internal hit rate is not inferred. Native page-file cache decisions and client router caching are not counted as data-cache hits.

Timings end when headers are ready, so streaming body time is excluded. Samples are bounded, can span process sessions, and are written under the app's `.prnext-cache/inspect` directory. Request bodies, headers, cookies, URL queries and credentials are omitted; runtime tag/path identifiers are hashed consistently. Logs retain at most 1 MiB per segment plus a previous segment, with old process sessions pruned. Under load, diagnostics may drop samples. `--inspect` also works with `prn dev`; standalone/native launches can set `PRNEXT_INSPECT_DIR` explicitly. No public diagnostic endpoint is added.

## Host several applications

```sh
npm run build -- examples/basic
npm run build -- examples/app
node packages/prnext/cli.mjs host examples/hosting/prnext.host.json --check
node packages/prnext/cli.mjs host examples/hosting/prnext.host.json
# In another terminal:
node packages/prnext/cli.mjs host examples/hosting/prnext.host.json --status
```

The example routes `basic.localhost:8080` and `app.localhost:8080` to separate applications. Resolve those hostnames to the listener address, or supply their exact `Host` header when testing. Installed packages use `prn host config.json`. Configuration roots are relative to the JSON file. Each app has a unique name, root and exact hostname list, with optional `memoryMb`, `idleSeconds`, `workers`, `profile`, `env` and `inspect` settings. `--status --json` reads the local status snapshot beside the configuration, including its age; it does not connect to a live admin endpoint. Restart the host to apply configuration or build changes.

The native gateway keeps each application asleep until requested. A waking app reserves its configured memory budget; if capacity is full, inactive apps can release theirs, while busy requests receive 503 rather than starting an unbudgeted app. Requests and streaming responses hold their reservation until completion or cancellation. Idle apps stop after `idleSeconds` and wake on the next request. Persistent caches remain on disk; in-process state and background jobs do not survive sleep. Apps receive their configured environment and a small platform environment allowlist, then load their own `.env` files.

The watchdog samples the RSS of each app's native server and descendants about once per second. Exceeding `memoryMb` stops that process tree, can interrupt its in-flight requests, and imposes a 30-second cooldown. V8 also receives an initial heap guard unless the app config supplies `NODE_OPTIONS`. These are sampled operating budgets, not kernel-enforced hard limits; allow extra RAM for the gateway, the OS and sampling overshoot. Process separation isolates caches, environment and ordinary failures, but apps run as the same OS user: host only trusted applications. Use separate users or containers for untrusted tenants.

Hosting supports HTTP streaming and preserves the original application Host. Protocol upgrades such as WebSockets return 501. Put a TLS reverse proxy in front for public hosting; this command does not configure DNS, TLS, OS services or deploy to a VPS. Windows, macOS and Linux use the same JSON format and CLI.

## Keep production apps running

`prn start` keeps its normal foreground behavior. Use the separate persistent commands when an app should survive closing the terminal:

```sh
prn build ./my-app
prn pstart ./my-app --name web --port 3000
prn pstatus
prn plogs web --follow
# After rebuilding the app:
prn prestart web
prn pstop web
```

`pstart` starts a detached supervisor and returns once the app passes its health check. Applications restart after a crash with increasing delays; ten failures within five minutes stop retries until `prestart`. A separate watchdog restarts the supervisor after a crash or an unresponsive event loop. Each app has a stable HTTP listener and its own native server and workers. This mode adds a Node HTTP proxy and two supervisor processes; it does not enable the idle sleep or memory reservations of `prn host`.

`prestart` copies the current production build, starts a replacement on a private port, and sends a GET to `--health-path` (default `/`). A 2xx or 3xx response must arrive within `--health-timeout 15000` milliseconds. Only then does new traffic switch to the replacement. If startup or the health check fails, the existing healthy instance keeps serving. Existing HTTP streams can finish for up to `--drain-timeout 30000` milliseconds, after which remaining requests are closed. Choose a health route that checks the dependencies your application needs. Two generations temporarily use memory and disk space during replacement.

Build copies live under the project's ignored `.prnext-persistent` directory and are removed after their processes stop. Rebuilding does not replace the active generation's compiled files. Project dependencies, `public` files and persistent caches remain shared; avoid changing dependencies or deleting public assets while old requests still need them. HTTP streaming, original Host headers and multiple cookies are preserved. WebSocket/protocol upgrades return 501. A supervisor crash can interrupt requests; health-checked replacement is not a guarantee against machine failures or incompatible application changes. A TLS reverse proxy can sit in front of the persistent listener.

Available commands:

| Command | Behavior |
| --- | --- |
| `prn pstart [directory] --name NAME` | Start or restore an app; identical repeated starts are idempotent |
| `prn prestart [name] [--all]` | Load the current build through a health-checked replacement |
| `prn pstop [name] [--all]` | Stop apps and keep them stopped across supervisor restarts |
| `prn pdelete [name] [--all]` | Stop apps and remove their saved configuration; retain logs |
| `prn pstatus [name] [--json]` / `prn plist` | Show status, PIDs, build IDs, starts and active requests |
| `prn plogs [name] --lines 100 --follow` | Read/tail app output; `--supervisor` selects supervisor logs |
| `prn pdown` | Stop the supervisor and apps, retaining enabled flags for their next launch |
| `prn pstartup [--remove]` | Enable/remove automatic restoration at user login |

Without a name, `prestart`, `pstop`, `pdelete` and `plogs` select the app registered for the current directory. `pstart` accepts `--hostname`, `--port`, `--workers`, `--profile`, `--inspect`, `--health-path`, `--health-timeout` and `--drain-timeout`; see `prn pstart --help`. Change saved listener/settings with `pdelete`, then `pstart`. Applications load their project `.env` files; arbitrary caller-shell variables and secrets are not copied into the saved registry. The state directory defaults to `~/.prnext/processes`; set `PRNEXT_PM_HOME` consistently for a separate supervisor. Keep that directory private: it contains local control credentials and application logs. Logs rotate at 10 MiB with three retained segments per app and for the supervisor. App output can contain whatever the application logs.

`pstartup` is opt-in and enables restoration on the **next user login**. On Windows it registers a hidden scheduled task for the current account; on macOS it writes a user LaunchAgent; on Linux it enables a systemd user service. These definitions restart a failed watchdog once managed by the OS. Windows and macOS user startup do not run before login. A Linux administrator can enable user lingering separately for boot-time operation without an interactive login. No OS startup settings change just by running `pstart`, and the command does not install a Windows system service or alter other accounts. Run `pstartup` again after moving or upgrading Node or the PRNext package. Platform references: [Windows scheduled tasks](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset), [Apple launch agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), [systemd user lingering](https://www.freedesktop.org/software/systemd/man/252/loginctl.html).

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

🧪 **Very early alpha — 0.1.1-alpha.** Next.js compatibility is still partial. This release is intended for experimentation and feedback, not production applications. Testing, feedback, and contributions are welcome.

## License and credits

PRNext is licensed under the [MIT License](LICENSE), copyright © 2026 Thomas (Lorkydey). Commercial use, modification, and redistribution are permitted; keep the copyright and license notice when distributing copies or substantial portions of the software. Third-party components retain their own licenses.

If PRNext helps your project, a credit such as **“PRNext by Thomas (Lorkydey)”** with a link to [prnext.dev](https://prnext.dev) would be appreciated. A public credit is optional, not an additional license condition.
