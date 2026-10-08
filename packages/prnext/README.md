<a href="https://prnext.dev"><img src="https://prnext.dev/favicon.svg" alt="PRNext logo" width="80" height="80"></a>

# PRNext

[Website](https://prnext.dev) · [npm](https://www.npmjs.com/package/@thomas.f/prnext) · [GitHub](https://github.com/Lorkydey/PRNext) · [Report an issue](https://github.com/Lorkydey/PRNext/issues)

A Rust-powered runtime for Next.js projects, with React and npm modules running on Node.js.

> **Very early alpha.** Built for experimentation and feedback. Next.js compatibility is partial; expect bugs, missing features and breaking changes.

## Latest update

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

Native package targets cover Windows MSVC arm64/x64, macOS arm64/x64 and Linux glibc arm64/x64. Windows runs directly from PowerShell or Command Prompt, without WSL. Alpine/musl is not a prebuilt target. Linux binaries are built on Ubuntu 22.04 with glibc 2.35. Framework and native components use matching release versions.

Keep npm optional dependencies enabled: PRNext automatically installs the binary for your platform. Rust is not required to use the published package.

</details>

## Links and feedback

- Website and benchmarks: [prnext.dev](https://prnext.dev)
- Source and contributions: [Lorkydey/PRNext](https://github.com/Lorkydey/PRNext)
- Bug reports: [GitHub Issues](https://github.com/Lorkydey/PRNext/issues)
- Questions and suggestions: [contact@heythomas.dev](mailto:contact@heythomas.dev)

<details>
<summary><strong>License & credits</strong></summary>

### License and credits

PRNext is licensed under the [MIT License](LICENSE), copyright © 2026 Thomas (Lorkydey). Commercial use, modification, and redistribution are permitted; keep the copyright and license notice when distributing copies or substantial portions of the software. Third-party components retain their own licenses.

If PRNext helps your project, a credit such as **“PRNext by Thomas (Lorkydey)”** with a link to [prnext.dev](https://prnext.dev) would be appreciated. A public credit is optional, not an additional license condition.

</details>
