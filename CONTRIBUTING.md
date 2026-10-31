# Contributing to PRNext

Thanks for helping improve PRNext. It is an early alpha: compatibility is partial,
and focused bug reports, reproductions and small pull requests are welcome.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Report a bug

Open a [GitHub issue](https://github.com/Lorkydey/PRNext/issues) with your PRNext,
Node.js and operating system versions, the steps to reproduce, and the expected
and actual behavior. A small repository or failing test helps us investigate.
Remove tokens, passwords and personal data from examples and logs.

For vulnerabilities, use the private channels in [SECURITY.md](SECURITY.md).

## Run the project

Install Node.js 22+, the repository's Rust toolchain, and the native build tools
listed under **Develop from this repository** in the [README](README.md).

```sh
npm ci
npm run build:native
npm run dev -- examples/app
```

The JavaScript package is in `packages/prnext`, the native runtime is in
`crates/prnext`, and integration and browser fixtures are in `tests`.

## Send a pull request

1. Create a branch from the current `main`; fork the repository if needed.
2. Keep the change focused. Explain the problem and resulting behavior in the PR.
3. Add a regression test for behavior changes and update the relevant documentation.
4. Run the checks affected by your change and report their results.
5. Wait for the required **CI result** check before merging.

Useful checks:

```sh
npm run test:unit
npm run test:types
npm run test:rust
npm run test:e2e
npm run test:browser
```

Browser tests need Chromium: `npx playwright install chromium`. Use
`npx playwright install --with-deps chromium` on a Linux development machine
when the browser's system dependencies are missing.

Documentation-only changes use lightweight checks for the allowlisted Markdown
files, PNG/GIF images directly inside `.github/assets/`, and `.github/FUNDING.yml`.
Scope tests, matching README copies and whitespace checks still report the required
**CI result**. Keep `README.md` and `packages/prnext/README.md` identical and run
`git diff --check`. Code, dependencies and CI configuration, including the scope
classifier itself, retain the full platform checks. Do not add skip-CI markers.

## Faster feedback before a push

Install the optional repository hook once per clone:

```sh
npm run hooks:install
```

The hook checks the complete pushed diff for whitespace, runs the small CI-tooling
regression suite, and checks library and example types for executable changes.
Allowlisted documentation updates use the lightweight path. A newly created remote
ref has unknown scope and also runs types. Push the checked-out commit from a clean
worktree so these checks validate the source being pushed. Fetch missing remote
commits before retrying; the hook does not fetch or install dependencies for you.
The installer preserves custom hooks and Git configuration, and reports a conflict
instead of replacing them. Linked worktrees share the dispatcher; checkouts without
the tracked hook continue to work normally.

## CI shards and timing reports

Linux, macOS and Windows each run the complete unit/type, integration and Chromium
suites. Integration and Chromium use two independent runners per platform, with
one test worker per runner. Each plan discovers the current files and verifies
complete, non-overlapping coverage before starting. Newly added files are included
automatically. Initial weights use reported integration durations from a successful
Windows CI run and browser durations from an earlier local Windows qualification.
They exclude some fixture/startup overhead. Unmeasured files receive a nonzero
median fallback. The manifest records the provenance and limits of these estimates.

Inspect or reproduce a shard locally:

```sh
node scripts/ci-shards.mjs --suite integration --shard 1/2 --list
node scripts/ci-shards.mjs --suite integration --shard 1/2
node scripts/ci-shards.mjs --suite browser --shard 2/2
npm run test:ci
```

The **CI timing and cache report** job compares the current run with up to 20 recent
runs. It records setup, checks/builds, tests and post-job time, plus observed exact npm
and Rust cache matches. Missing observations remain unknown. Time before a job
starts includes dependency waits and cannot establish runner queue time alone.
Documentation-only, unsuccessful and incomplete runs are identified separately
from successful platform runs. Runner totals measure work across parallel jobs;
they differ from elapsed feedback time.

The `ci-timing-report` artifact contains the JSON and Markdown report and a compact
cache snapshot. The five most recent completed runs can supply historical cache
observations once those snapshots exist; missing or expired data stays unknown.
Per-runner `ci-metrics-*` artifacts contain cache observations; `ci-tests-*` artifacts contain
the shard plans and Chromium JSON timings. Use these measurements to tune the
split. The **Analyze CI history** manual workflow produces a fresh report without
running the platform matrix. Dependency caches store downloaded packages and
`npm ci` still creates each installation.

The required **CI result** still depends on all platform checks. Timing reports
add diagnostics and do not replace that validation.

## Versions and releases

See [RELEASE.md](RELEASE.md) for available versions, supported environments,
validation results and upgrade instructions. [CHANGELOG.md](CHANGELOG.md)
describes the changes in each version. Alpha versions are experimental
prereleases with partial Next.js compatibility.

Contributions are distributed under the repository's [MIT License](LICENSE).
