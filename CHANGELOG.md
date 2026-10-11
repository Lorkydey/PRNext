# Changelog

## 0.1.12-alpha — prepared 2026-10-11

### Fixed

- Client disconnections no longer automatically restart a healthy shared Node render host. Incomplete transport lanes are discarded; fully validated terminal frames allow safe reuse. Cancellation admission, deadlines and background work remain bounded and tracked.
- Worker retirement waits for real inactivity and tracked finalization. Dynamic builds carry a fingerprinted lifecycle contract, rejected early when missing, incompatible or mixed.
- Filesystem admission bounds live file responses, queued callers and submitted helper tasks. Overload returns explicit noncacheable 503 responses with `Retry-After`; cancellation releases queued work and running OS work retains its permit until completion.
- Pages data requests preserve filesystem overload as 503 instead of attempting a 500 error render. Proxy-generated overload and transport errors now also use `Cache-Control: no-store`.
- Clean `npm ci` has complete native optional dependency lock entries. Framework, native descriptors, Cargo and workspace versions are synchronized.
- `reactCompiler: false`, `typedRoutes: false` and explicit TypeScript checking options are accepted. Unsupported enabled compiler/typed-route features fail with actionable diagnostics rather than being ignored.

### Tradeoffs and known limits

- Defaults remain `balanced` for `start` and `memory` for `host`. Idle retirement reduces retained memory and adds startup latency to the next response. Host sleep stops the whole application, including in-process background work; it is separate from worker retirement.
- The V6 static admission bounds fix uncontrolled queue growth; they do not imply higher peak throughput. The prior Windows small-gzip comparison measured a roughly 3.9% lower median throughput with overlapping ranges and host-load limitations.
- Eight independent apps on one CPU with a Windows Job **commit** limit of 1 GiB and experimental `balanced` plus `NODE_OPTIONS=--max-semi-space-size=1` still have a known allocation-failure regression: V6 failed 2/5 original trials versus V5 0/5, and 1/3 new trials versus V5 0/3. The instrumented follow-up found no retained filesystem queue/permits after drain. The fine cause remains unidentified; **not fixed**. Do not use this experiment as a supported density target. `balanced-small` is not a built-in profile.
- Next.js compatibility remains partial. TypeScript checks require an explicit `typescript` option and the app's installed TypeScript; generated route types, React Compiler and the Next.js language-service plugin remain unsupported.
- Ubuntu 24.10 x64 validation passed installation, application builds, 122 targeted integration tests, the three-app `host` scenario and both isolated npm installation layouts. The Linux binary was cross-compiled on Windows and executed on Ubuntu. macOS and ARM64 validation remains pending; verify each native archive on its target platform before publication.
- Host budgets sample per-app RSS; they are not hard kernel limits. WebSocket upgrades are unsupported. A request racing an app crash can return 502; subsequent requests receive 503 during the five-second crash cooldown. The proxy does not replay requests.

### Upgrade

Install the matching framework/native release, then run `prnext build <project>` and restart each application. Rebuild standalone deployments on their target OS/architecture and redeploy the whole output. Old dynamic artifacts without the new runtime contract are deliberately rejected; copying only the native executable or a contract file is insufficient. A legacy build containing only static files remains usable without Node.

See [RELEASE.md](RELEASE.md) for checks, native archive collection and ordered publication commands. This working tree prepares the release; it does not publish it.

## 0.1.1-alpha — 2026-10-08

**README update:** `0.1.11-alpha` updates the README documentation only, with no runtime behavior changes.

### Added

- Native Windows x64 and ARM64 packages, alongside macOS and Linux glibc support.
- Persistent app management with `prnext pstart`, health-checked replacements, crash recovery, rotating logs and optional restoration at user login.
- `prnext migrate --check` for source compatibility audits and optional GET response comparisons between an existing app and a PRNext candidate.
- `prnext inspect` and opt-in `--inspect` diagnostics for route rendering, cache decisions and request timings.
- `prnext host` for hostname-based multi-app hosting, with on-demand startup, idle sleep and sampled memory budgets.

### Fixed

- Standalone dependency tracing across Windows drives, scoped packages and workspace path aliases.
- Development child-process shutdown and file replacement on Windows.
- Cold-worker connection bursts that could exceed small operating-system listen backlogs, including on macOS.
- Windows npm packaging and generated migration scripts. Scripts now use the portable `prnext` command; `prn` remains available in compatible shells.

### Alpha limitations

Next.js compatibility remains partial; this release is for experimentation and feedback. Migration comparisons check response samples, not browser behavior or complete functional parity. Inspector timings stop at response headers. Hosting memory budgets are sampled, not hard limits, and host/persistent proxies do not support WebSocket upgrades. No new performance benchmark results are claimed for this release.
