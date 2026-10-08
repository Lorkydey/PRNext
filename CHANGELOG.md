# Changelog

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
