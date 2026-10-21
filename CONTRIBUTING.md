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

Documentation-only changes use lightweight checks when their files are explicitly
allowlisted. Keep `README.md` and `packages/prnext/README.md` identical and run
`git diff --check`. Do not add skip-CI markers to commits: the required validation
must still report its result. Code, dependencies and CI configuration retain the
full platform checks.

## Versions and releases

Follow [RELEASE.md](RELEASE.md) when changing a version. Each released version gets
a matching GitHub tag and release with notes from [CHANGELOG.md](CHANGELOG.md).
Alpha versions must be marked as prereleases. GitHub source releases and npm
publication are separate steps; never attach unverified or mismatched binaries.

Contributions are distributed under the repository's [MIT License](LICENSE).
