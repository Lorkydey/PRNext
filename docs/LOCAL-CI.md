# Local development checks

Run the fast development checks from a PRNext source checkout:

```sh
npm run ci:quick
```

This runs tooling regressions, runtime and native-resolution unit tests, and the three TypeScript projects. It avoids build-dependent unit suites and the native dev-server integration scenario that can trigger a cold Rust compilation. Unexpected native use fails promptly in this mode; the full unit command retains those scenarios. For all unit suites plus native, integration and Chromium coverage on your current platform and Node runtime:

```sh
npm run ci:local
```

The full mode builds the native executable, checks Rust formatting and Clippy, runs Rust tests, and executes all integration and browser files in four exhaustive shards per suite. Each shard gets its own source and dependencies, so example builds and workspace links cannot point at another shard's output. Two jobs run at a time by default; machines with sufficient memory can use up to four:

```sh
npm run ci:local -- --jobs 4
npm run ci:local -- --list
```

Use a supported patched Node runtime: 22.23.4+, 24.22.1+ or 26.12.1+. Full mode also requires Rust 1.98.0 and its formatting/Clippy components, plus the platform's native build tools. On Linux and macOS, make Redis available on PATH or set `PRNEXT_REDIS_SERVER`. On Windows, full mode prepares the same checksum-pinned portable Redis used by CI inside its private cache. No Redis service is installed.

The first run downloads locked npm dependencies and, for browser coverage, Chromium. Rust can also populate its dependency cache. Subsequent runs reuse the isolated dependencies, Node compile cache, package downloads and Cargo target. Dependency changes invalidate the relevant installation cache. Choose a private cache location if needed:

```sh
npm run ci:quick -- --cache /path/outside/the/checkout
```

The default cache is under your temporary directory at `prnext-local-ci/`, separated by checkout, architecture and exact Node version. The tool locks that cache for the run. A second process refuses to overwrite an active validation. Reports and per-step logs are written under its `reports/` directory; the final line prints the report path and whether validation passed.

Checks run on an isolated snapshot of tracked files and non-ignored new files, including uncommitted code. Local `.env` files are excluded, account tokens are not forwarded, and npm configuration, Git configuration and process-manager state use private paths. The original checkout and its `node_modules` are preserved. Editing source while a run is in progress prevents that run from reporting a passing result for the current source. Ctrl+C cancels the owned validation processes.

Quick mode is development feedback. Full mode covers this computer and the selected Node runtime. The required remote platform, browser-engine and runtime matrix still qualifies the change before merge.
