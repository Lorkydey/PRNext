<a href="https://prnext.dev"><img src="https://prnext.dev/favicon.svg" alt="PRNext logo" width="80" height="80"></a>

# PRNext

[Website](https://prnext.dev) · [npm](https://www.npmjs.com/package/@thomas.f/prnext) · [GitHub](https://github.com/Lorkydey/PRNext) · [X / @PRNextdev](https://x.com/PRNextdev) · [Report an issue](https://github.com/Lorkydey/PRNext/issues)

A Rust-powered runtime for Next.js projects, with React and npm modules running on Node.js.

> **Very early alpha.** Built for experimentation and feedback. Next.js compatibility is partial; expect bugs, missing features and breaking changes.

## Latest update

**0.1.12-alpha — stability and bounded resource usage.** Client cancellations retain healthy Node hosts; worker retirement protects tracked finalization; filesystem and proxy overload return explicit, noncacheable 503 responses. Clean installs and runtime/native/build consistency checks are part of the release path. Rebuild dynamic applications with `prnext build` after upgrading, then restart them.

The experimental eight-app `balanced`/1 GiB Windows commit configuration with `NODE_OPTIONS=--max-semi-space-size=1` still has a reproduced allocation-failure regression relative to V5. It is not a supported density target and is not fixed. Defaults remain `start=balanced` and `host=memory`. Compatibility remains partial, including the compiler and TypeScript limits below.

<details>
<summary><strong>0.1.1-alpha · October 8, 2026 · Features & fixes</strong></summary>

**README update:** `0.1.11-alpha` updates the README only; runtime features and fixes remain those of `0.1.1-alpha`.

### Added

- **Windows x64 & ARM64:** native packages alongside macOS and Linux glibc support.
- **Persistent apps:** background processes, crash recovery, rotating logs, health-checked replacements and optional restoration at login.
- **Multi-app hosting:** hostname routing, on-demand startup, idle sleep and sampled memory budgets.
- **Migration checks:** source audits and optional GET response comparisons with `migrate --check`.
- **Inspector:** opt-in route, cache and request timing diagnostics.

### Fixed

- Standalone dependency tracing for Windows drives, scoped packages and workspace aliases.
- Development process shutdown and file replacement on Windows.
- Cold-worker connection bursts on macOS.
- Windows package publishing and portable `prnext` migration scripts.

</details>

[Full changelog](https://github.com/Lorkydey/PRNext/blob/main/CHANGELOG.md)

## Install & upgrade

Node.js **22+** · Windows, macOS and Linux glibc · x64 and ARM64

<details>
<summary><strong>Install · migrate an existing Next.js app</strong></summary>

Run these commands from your application directory. The current alpha requires matching React, React DOM and React Server Components versions:

```sh
npm install @thomas.f/prnext@alpha react@19.3.0 react-dom@19.3.0 react-server-dom-webpack@19.3.0
npx --no-install prnext migrate --dry-run
npx --no-install prnext migrate
npx --no-install prnext check
npx --no-install prnext dev
```

Review the dry run before applying migration. Migration backs up your package files and keeps Next.js and your application source. Compatibility checks help find issues; they do not guarantee that every Next.js feature works.

Install only `@thomas.f/prnext`. Keep optional dependencies enabled: npm installs the matching native component automatically. Rust is not required to use a published release.

`reactCompiler: false` and `typedRoutes: false` are supported. Enabling either option fails with an explicit diagnostic: PRNext does not yet run React Compiler or generate and validate typed route declarations. Keep builds that require these features on Next.js.

Set `typescript: {}` to check an existing `tsconfig.json` during production builds using the application's installed `typescript` package. `typescript.tsconfigPath` selects a custom configuration for type checking and compilation, including its inherited path aliases. `typescript.ignoreBuildErrors: true` explicitly skips the production check; development builds also skip it. Checks run in a temporary child process without emitting files or editing the configuration. Unlike Next.js, omitting `typescript` preserves PRNext's existing transpile-only behavior. PRNext does not install TypeScript, create `next-env.d.ts`, generate Next.js route types, or implement the Next.js TypeScript language-service plugin; retain the project's type declarations and run separate editor checks as needed. See the [Next.js option definitions](https://nextjs.org/docs/app/api-reference/config/next-config-js/typescript).

</details>

<details>
<summary><strong>Upgrade · update an existing PRNext project</strong></summary>

Stop your development or production process before changing dependencies. If you use `pstart`, follow the [persistent app upgrade guide](https://github.com/Lorkydey/PRNext#upgrade-persistent-apps) first.

```sh
npm install @thomas.f/prnext@alpha react@19.3.0 react-dom@19.3.0 react-server-dom-webpack@19.3.0
npx --no-install prnext --version
npx --no-install prnext check
npx --no-install prnext build
```

Then restart your app with its usual command; for a foreground production server:

```sh
npx --no-install prnext start
```

This updates the existing `@thomas.f/prnext` dependency and its native component together. You do not need to migrate an already-migrated project again. Commit the updated package manifest and lockfile.

Use `@alpha` to select the current alpha release. `latest` is a separate npm tag; a dependency already installed in a project does not change until you update it.

</details>

<details>
<summary><strong>Build & run · development and production</strong></summary>

For development:

```sh
npx --no-install prnext dev
```

For production:

```sh
npx --no-install prnext build
npx --no-install prnext start
```

The portable command is `prnext`. The shortcut `prn` is available in compatible shells. On Windows 10 and Windows Server 2022, use `prnext`: [Windows reserves the name PRN](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).

</details>

<details>
<summary><strong>Runtime profiles · balanced, speed, memory and classic</strong></summary>

Balanced is the default. Set a profile when starting the production server:

| Profile | Command | Priority |
| --- | --- | --- |
| Balanced | `npx --no-install prnext start --profile balanced` | Memory, CPU and response times |
| Speed | `npx --no-install prnext start --profile speed` | Throughput and responsiveness |
| Memory | `npx --no-install prnext start --profile memory` | Lower memory usage |
| Classic | `npx --no-install prnext start --profile classic` | Original runtime settings |


Worker retirement can be configured in `next.config.mjs` (PRNext extension):

```js
export default {
  workerRetirement: { idleSeconds: 300, laneIdleSeconds: 30, keepWarm: false },
};
```

Values are resolved **per field**: CLI > process environment > built configuration > profile.
The CLI options are `--worker-idle-seconds`, `--lane-idle-seconds`, and
`--keep-warm [true|false]` (a bare flag means true). The corresponding environment
variables are `PRNEXT_WORKER_IDLE_SECONDS`, `PRNEXT_LANE_IDLE_SECONDS`, and
`PRNEXT_KEEP_WARM` (`true`/`false` or `1`/`0`). Seconds must be integers from 0 to
604800; invalid supplied values fail even when a higher-priority value exists.
Configuration-file changes require a new build; CLI/environment changes require
restarting the server.

`idleSeconds: 0` disables host idle retirement. `laneIdleSeconds: 0` disables
early retirement of surplus lanes; the host deadline still applies to those
lanes. Set both to zero to disable all idle retirement. `keepWarm: true` overrides
the resolved host deadline and retains one primary lane per used host, while
surplus lanes still retire. It creates no workers or artificial requests before
real traffic. To restore a shorter CLI deadline when a lower-priority source sets
`keepWarm: true`, also pass `--keep-warm false`. Active requests across **all**
lanes reset the host deadline; streams and tracked post-response work remain
protected. Keeping a host warm trades retained memory for lower wake latency;
it does not change the profile's response, buffer or V8 limits.

New builds include `runtime-contract.json`, separately declaring transport and
lifecycle versions and fingerprints of the runtime modules. `start` and
`host --check` reject missing, incompatible, future or mixed dynamic runtimes
before accepting traffic and print `prnext build <project>`. Rebuild and restart after
updating PRNext. Keep the selected production build immutable while it is in
use; this is a startup check, not a continuous file watcher. A copied metadata file cannot upgrade old runtime modules;
`--worker` must remain inside the verified build runtime directory. This is
artifact consistency checking, not a signature or a sandbox. Legacy builds
without any worker routes or middleware can still serve files without Node.
The multi-app `host` supervisor's whole-application `idleSeconds`/memory policy
is separate: keeping a Node worker warm does not override application sleep,
shutdown or resource-budget termination.

`prnext start` sizes Tokio's blocking I/O pool to four times the larger of its
runtime thread count and requested render workers (minimum 4, maximum 256).
`PRNEXT_BLOCKING_THREADS=1..1024` explicitly overrides it. This bounds threads,
not the number of incoming HTTP connections. Filesystem admission separately
bounds submitted blocking work and file response bodies, including slow clients:

| Environment variable | Default | Accepted range | Scope per server process |
|---|---:|---:|---|
| `PRNEXT_FILE_CONCURRENCY` | 64 | 1–4096 | File preparation and live file source bodies |
| `PRNEXT_FILE_WORK_CONCURRENCY` | 16 | 1–1024 | Submitted static/path/cache helper tasks, queued or running |
| `PRNEXT_FILE_QUEUE` | 128 | 0–4096 | Waiting callers at each admission gate; 0 rejects immediately |
| `PRNEXT_FILE_WAIT_MS` | 2000 | 1–60000 | Maximum admission wait at each gate |

Invalid values fail startup before listening. Full queues and admission timeouts
return HTTP 503 with `Retry-After: 1` and `Cache-Control: no-store`. These deadlines
apply to admission, not the duration of an accepted response. Cancelling a queued
caller releases its slot. An already running filesystem operation keeps its
permit until it settles, including a pending file read after a client disconnects;
an operating-system call cannot be forcibly cancelled safely. Large file bodies
use a one-frame channel with backpressure. No deadline cuts off an active stream.
Their asynchronous open/read operations retain a file-response permit; they are
not included in the helper-task queue counter. These controls are not a global
limit on application or background I/O.
The limits do not bound TCP/kernel buffers or all HTTP connections, and an
unresponsive disk can occupy the bounded capacity until its operation returns.
Pages cache lookups use the same bounded filesystem admission. Their overload
follows the existing page-capacity 503 path, including Pages JSON requests;
it does not invoke error-page generation or regenerate a valid cached page.

File operations stay off the async runtime threads; HTTP validators, range
handling and path confinement are unchanged. The multi-app supervisor retains
its existing pool sizing because
its long-lived child-output readers have different requirements.

For local diagnosis only, `PRNEXT_METRICS_FILE=<path>` adds one observer thread
and cumulative counters once per second (file wraps at 16 MiB). It reports
Tokio threads, instrumented filesystem tasks/queues and worker events. Nested
filesystem timings are wall time, not CPU, and must not be added together.
`fileAdmission` and `fileWorkAdmission` report occupancy, peaks, submitted and
released work, rejections, timeouts, cancelled waits and wait duration. Their
`waitingHeaderBytes` estimate counts URI and header content only; it excludes
allocation overhead, request objects, bodies and TCP/kernel buffers. Use process
memory measurements for the total footprint. Metrics never initialize admission
settings or override values selected at startup.
`activeJobs` sums transport jobs across the separate render/API pools;
`queuedJobs` excludes HTTP callers waiting before transport admission.
`laneIdleRetirements` includes release of a cancelled lane's retained host
reference, so it is not a count of distinct TCP connections closed. Host starts
and watchdog kills are separate events; RSC isolate restarts do not have an
independent cumulative counter. Normal operation has no observer thread or
sampling timer.
`--inspect` additionally records Node startup, module and RSC initialization
phases; use uninstrumented runs for throughput comparisons.

Render workers start on demand. Idle connection lanes retire after 30 seconds in `memory` and legacy `compact`. `balanced` keeps each host's primary lane warm for 300 seconds and retires surplus lanes after 30 seconds; `speed` and `classic` keep primary lanes warm and retire surplus lanes after 30 seconds. Retirement waits on idle deadlines rather than polling. Active responses and streams retain their lanes, and tracked application work keeps its Node host available even after the last lane retires. New requests can reuse that host while cache finalization continues. Once the work settles, the existing heartbeat releases this retention within one second. Releasing idle workers lowers retained memory but adds worker startup and module loading to the next request.

Client disconnections release response permits and close incomplete transport lanes while retaining a healthy shared Node process. A lane whose terminal frame was fully validated can be reused. App Router cancellation pressure pauses new admission until abandoned work settles, with bounded queues and the original request deadlines; it does not immediately terminate unrelated responses. Successful response completion ends the RSC response deadline, while cache writes remain tracked until settlement. During this post-response work only, a shared watchdog probes the RSC isolate every five seconds and retires it if an acknowledgement takes more than 30 seconds. This measures responsiveness, not the total duration of asynchronous cache work; no RSC watchdog timer runs when that work is absent. Existing limits on cancelled requests and other API or middleware background work still apply.

Explicit disposal of a worker pool starts a separate graceful shutdown: tracked work has up to 30 seconds to drain before Rust terminates and reaps the process, including a blocked JavaScript event loop. This shutdown grace does not limit normal idle cache finalization. Arbitrary detached tasks are outside the tracked lifecycle; applications that rely on them or long-lived in-process state should use `speed` or `classic` to keep their primary host warm. Such tasks are still not preserved across shutdown or worker failure.

The `memory` profile allows 28 live responses with 8 render starts, a 1 MiB response buffer budget and its existing small V8 nursery. `balanced` retains 32 live responses and `speed` retains 128. These limits bound concurrency independently of idle retirement.

`balanced` uses a 4 MiB V8 semi-space without `--optimize-for-size`, keeping its RSC young-generation setting at 16 MiB. This selection reduces measured CPU per response at the cost of higher RSS than the previous size policy. It keeps 16 render starts, a 4 MiB response buffer and 300-second host retirement; `speed` uses 32 starts, a 16 MiB buffer and keeps hosts warm. In the measured SSR/streaming fixtures, cumulative RSS remained below Next.js, but that is not a universal memory guarantee. The final Windows validation includes three 30-second measurements per scenario after warm-up and a one-hour mixed endurance run. The CPU/RSS trade-off remains workload-dependent; comparable Linux performance and Nginx benchmarks have not been run.

An explicit `NODE_OPTIONS="--max-semi-space-size=4"` (including Node's underscore spelling) overrides the profile's nursery policy. PRNext also omits `--optimize-for-size` in that case: on Node 24.19.0, V8 otherwise replaces the explicit value with 1 MiB. This opts out of V8's broader size policy as well, so CPU and memory consumption can change; measure the chosen value for your workload. It does not add an old-generation heap limit or change the profile's admission, response buffers or idle retirement. Without an explicit override, PRNext uses the defaults of the selected profile.

The V6 multi-application campaign keeps `start` on `balanced` and `host` on
`memory`. With one shared CPU on Windows, `memory` completed both short trials
at four applications / 512 MiB and eight applications / 1 GiB without allocation
limit events. Its one-hour validation used four applications / 1 GiB, not those
lowest budgets: 1,626,564 useful responses and 960 intentional cancellations,
with no HTTP or validation errors. `balanced` gave lower neighbouring-application
tail latency when the larger memory budget was available. These are independent
`start` instances, not a benchmark of the hosting proxy. Windows commit limits,
an active pagefile and process RSS sums are not Linux cgroup/PSS measurements;
equivalent Linux density and endurance measurements remain pending. The local V6 report retains failures,
variability and the small-static throughput cost of bounded admission.

The filesystem work limit remains 16, the setting validated under overload and
throughout the final endurance run. An explicit `PRNEXT_FILE_WORK_CONCURRENCY=64`
improved small-file throughput by about 5% in two short configuration trials,
but allows four times as many submitted helper tasks. It has not received the
same endurance validation and is not a universal profile improvement.

Results depend on your workload; see the [benchmark and its methodology](https://github.com/Lorkydey/PRNext#early-benchmarks-against-nextjs).

</details>

## Guides

<details>
<summary><strong>Migration audit, inspector and multi-app hosting</strong></summary>

### Migration audit, inspector and multi-app hosting

```sh
prnext migrate ./my-app --check --json
prnext migrate ./my-app --check --against http://localhost:3000 --candidate http://localhost:3001 --routes paths.json
prnext start ./my-app --inspect
prnext inspect ./my-app --json
prnext host prnext.host.json --check
prnext host prnext.host.json
prnext host prnext.host.json --status --json
```

The migration audit reports file/line diagnostics without rewriting the application. Response comparison checks GET status, redirects and normalized bodies between servers you start separately. HTML comparison excludes scripts/styles and does not replace browser tests.

The inspector explains build decisions and summarizes optional local HTTP, fetch, cache and invalidation samples. Durations end at response headers. Runtime logs omit request bodies, credentials and query strings, and hash tag/path identifiers. Measurements are bounded and may drop samples under load.

The host uses separate native server/Node process trees, starts apps on demand and stops idle apps. A minimal configuration is `{"memoryMb":512,"apps":[{"name":"site","root":"./site","hosts":["site.localhost"],"memoryMb":256,"idleSeconds":300}]}`. Roots are relative to this file; apps must already have production builds. Additional app options are `workers`, `profile`, `env` and `inspect`. The listener defaults to `127.0.0.1:8080`; set `hostname` and `port` explicitly when needed.

Memory budgets reserve capacity and monitor process-tree RSS about once per second. An excess stops the app and imposes a 30-second cooldown; this is not a kernel hard limit. Leave memory for the gateway, OS and overshoot. Sleeping loses in-process state and background work. Apps run as the same OS user, so this mode is for trusted applications. HTTP streaming is supported; WebSocket upgrades are not. Configure public DNS/TLS and OS services separately.

The Windows release check used four apps on one shared CPU and a 1 GiB Job commit budget. Two 30-second mixed SSR/stream/API trials measured about 333 requests/s through `host` versus 361 directly with the same V8 heap guard. Matching direct controls followed the host trials; this roughly 8% cost is specific to the fixture. Three sleep/resume cycles per trial used `idleSeconds: 3`: 32 simultaneous arrivals completed in 1.92–2.35 seconds, with one startup per app and no failures. The default whole-app deadline remains 300 seconds. The gateway's status/RSS monitor continues while apps sleep, so idle CPU is not zero. No host endurance or Linux performance result is claimed.

See the [repository guide and example configuration](https://github.com/Lorkydey/PRNext#host-several-applications) for the full workflow.

</details>

<details>
<summary><strong>Persistent production commands</strong></summary>

### Persistent production commands

`prnext start` remains a foreground command. Use `prnext pstart --name web --port 3000` to keep a built app running after the terminal closes. `prnext pstatus` (or `plist`) lists apps, `prnext plogs web --follow` tails logs, `prnext prestart web` loads the current build through a health check, and `prnext pstop web` stops it. `pdelete` removes saved settings; `pdown` stops the supervisor while preserving enabled apps for restoration. Lifecycle commands accept `--all` where shown by `prnext pstart --help`.

Apps restart after crashes with increasing delays and a retry limit. A separate watchdog supervises the manager. Replacements get a private build copy and must return HTTP 2xx/3xx from `--health-path /` within `--health-timeout 15000` ms before traffic switches; a failed candidate leaves the old instance serving. Existing requests can finish for `--drain-timeout 30000` ms. Dependencies, public files and disk caches remain shared. This adds a Node HTTP proxy; WebSocket upgrades are not supported and crashes can interrupt requests.

Settings, control credentials and logs live in `~/.prnext/processes` (`PRNEXT_PM_HOME` overrides it). Logs rotate at 10 MiB plus three older segments. Apps load project `.env` files; caller-shell secrets are not saved. `prnext pstartup` opts into restoration on the next user login through Windows Task Scheduler, a macOS LaunchAgent or a Linux systemd user service; `--remove` removes that startup configuration. Windows/macOS startup is per-user, not a pre-login system service. Linux boot-time operation requires administrator-configured user lingering. Re-run `pstartup` after moving or upgrading Node or PRNext. See the [persistent command guide](https://github.com/Lorkydey/PRNext#keep-production-apps-running).

Before upgrading a supervised application, follow the [persistent app upgrade guide](https://github.com/Lorkydey/PRNext#upgrade-persistent-apps).

</details>

<details>
<summary><strong>Platforms</strong></summary>

### Platforms

Native package targets cover Windows MSVC arm64/x64, macOS arm64/x64 and Linux glibc arm64/x64. Windows runs directly from PowerShell or Command Prompt, without WSL. Alpine/musl is not a prebuilt target. The native Linux CI builds use Ubuntu 22.04 with glibc 2.35. Framework and native components use matching release versions.

Keep npm optional dependencies enabled: PRNext automatically installs the binary for your platform. Rust is not required to use the published package.

</details>

## Links and feedback

- Website and benchmarks: [prnext.dev](https://prnext.dev)
- Source and contributions: [Lorkydey/PRNext](https://github.com/Lorkydey/PRNext)
- Project updates on X: [@PRNextdev](https://x.com/PRNextdev)
- Bug reports: [GitHub Issues](https://github.com/Lorkydey/PRNext/issues)
- Questions and suggestions: [contact@heythomas.dev](mailto:contact@heythomas.dev)

<details>
<summary><strong>License & credits</strong></summary>

### License and credits

PRNext is licensed under the [MIT License](LICENSE), copyright © 2026 Thomas (Lorkydey). Commercial use, modification, and redistribution are permitted; keep the copyright and license notice when distributing copies or substantial portions of the software. Third-party components retain their own licenses.

If PRNext helps your project, a credit such as **“PRNext by Thomas (Lorkydey)”** with a link to [prnext.dev](https://prnext.dev) would be appreciated. A public credit is optional, not an additional license condition.

</details>
