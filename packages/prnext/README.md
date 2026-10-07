<a href="https://prnext.dev"><img src="https://prnext.dev/favicon.svg" alt="PRNext logo" width="80" height="80"></a>

# PRNext

[Website](https://prnext.dev) · [GitHub](https://github.com/Lorkydey/PRNext) · [Report an issue](https://github.com/Lorkydey/PRNext/issues)

A Rust-powered runtime for Next.js projects, with React and npm modules running on Node.js.

> **Very early alpha — 0.1.1-alpha**
>
> Built for experimentation and feedback, not production applications. Next.js compatibility is partial. Expect bugs, missing features and breaking changes.

## Install and migrate

Node.js 22+ is required. This alpha uses matching React, React DOM and React Server Components versions:

```sh
npm install @thomas.f/prnext@alpha react@19.3.0 react-dom@19.3.0 react-server-dom-webpack@19.3.0
npx --no-install prnext migrate --dry-run
npx --no-install prnext migrate
npx --no-install prnext check
npx --no-install prnext dev
```

The package provides both `prnext` and its shortcut `prn`. On Windows 10 and Windows Server 2022, use `prnext`: [Windows reserves the name `PRN`](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file). Migration generates portable `prnext` scripts on every platform, backs up your package files and keeps Next.js and your application source. The preflight check does not guarantee full compatibility with your application.

## Build and run

```sh
npx --no-install prnext build
npx --no-install prnext start
```

Balanced is the default production profile. Choose a profile with:

```sh
npx --no-install prnext start --profile balanced
npx --no-install prnext start --profile speed
npx --no-install prnext start --profile memory
npx --no-install prnext start --profile classic
```

## Migration audit, inspector and multi-app hosting

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

## Persistent production commands

`prnext start` remains a foreground command. Use `prnext pstart --name web --port 3000` to keep a built app running after the terminal closes. `prnext pstatus` (or `plist`) lists apps, `prnext plogs web --follow` tails logs, `prnext prestart web` loads the current build through a health check, and `prnext pstop web` stops it. `pdelete` removes saved settings; `pdown` stops the supervisor while preserving enabled apps for restoration. Lifecycle commands accept `--all` where shown by `prnext pstart --help`.

Apps restart after crashes with increasing delays and a retry limit. A separate watchdog supervises the manager. Replacements get a private build copy and must return HTTP 2xx/3xx from `--health-path /` within `--health-timeout 15000` ms before traffic switches; a failed candidate leaves the old instance serving. Existing requests can finish for `--drain-timeout 30000` ms. Dependencies, public files and disk caches remain shared. This adds a Node HTTP proxy; WebSocket upgrades are not supported and crashes can interrupt requests.

Settings, control credentials and logs live in `~/.prnext/processes` (`PRNEXT_PM_HOME` overrides it). Logs rotate at 10 MiB plus three older segments. Apps load project `.env` files; caller-shell secrets are not saved. `prnext pstartup` opts into restoration on the next user login through Windows Task Scheduler, a macOS LaunchAgent or a Linux systemd user service; `--remove` removes that startup configuration. Windows/macOS startup is per-user, not a pre-login system service. Linux boot-time operation requires administrator-configured user lingering. Re-run `pstartup` after moving or upgrading Node or PRNext. See the [persistent command guide](https://github.com/Lorkydey/PRNext#keep-production-apps-running).

## Platforms

Native package targets cover Windows MSVC arm64/x64, macOS arm64/x64 and Linux glibc arm64/x64. Windows runs directly from PowerShell or Command Prompt, without WSL. Alpine/musl is not a prebuilt target. Linux binaries are built on Ubuntu 22.04 with glibc 2.35. Windows archives must be published alongside the matching framework version before registry consumers can install them.

Keep npm optional dependencies enabled: PRNext automatically installs the binary for your platform. Rust is not required to use the published package.

## Links and feedback

- Website and benchmarks: [prnext.dev](https://prnext.dev)
- Source and contributions: [Lorkydey/PRNext](https://github.com/Lorkydey/PRNext)
- Bug reports: [GitHub Issues](https://github.com/Lorkydey/PRNext/issues)
- Questions and suggestions: [contact@heythomas.dev](mailto:contact@heythomas.dev)

## License and credits

PRNext is licensed under the [MIT License](LICENSE), copyright © 2026 Thomas (Lorkydey). Commercial use, modification, and redistribution are permitted; keep the copyright and license notice when distributing copies or substantial portions of the software. Third-party components retain their own licenses.

If PRNext helps your project, a credit such as **“PRNext by Thomas (Lorkydey)”** with a link to [prnext.dev](https://prnext.dev) would be appreciated. A public credit is optional, not an additional license condition.
