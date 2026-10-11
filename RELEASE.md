# Preparing 0.1.12-alpha

This is a runtime release, not a metadata-only update. Do not reuse the
0.1.11-alpha native archives. Nothing in this preparation publishes or pushes.
The npm registry was checked for the wrapper and all six native packages on
2026-10-11: `0.1.11-alpha` was their alpha tag and `0.1.12-alpha` was unpublished.
Check again immediately before publication.

## Versions and lockfile

`scripts/release-version.mjs 0.1.12-alpha` synchronized the root workspace,
framework manifest, all six optional native versions, Cargo and both lockfiles.
It refuses existing registry versions. Native packages are generated from
`packages/prnext/native/platforms.json` by the existing packaging command.

The new native archives do not exist in the public registry yet. Their lock
entries therefore have exact versions, registry URLs and platform constraints,
but **no invented or reused integrity hashes**. A clean `npm ci` works before
publication; missing optional natives are expected, and contributors must build
Rust. Consumer installation is tested separately against the actual produced
archives through a temporary loopback registry. After publishing the natives,
`node scripts/release-lock.mjs` fills the real registry integrity values. Do not
remove the six entries or regenerate the lock from a platform-pruned install.

For a later version collision, select the next free alpha version with:

```sh
node scripts/release-version.mjs 0.1.12-alpha.1
```

Then rebuild and retest every archive. Do not relabel an old executable.

## Local checks

Use Node 24.19.0 / npm 11.12.1 / Rust 1.98.0 to repeat the preparation checks.
Node 22+ remains the supported package range; preparation on Node 24 is not a
claim that every Node/OS combination was tested locally.

```sh
npm ci
npm run release:check
npm run build:native -- --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
npm run test:unit
npm run test:types
npm run test:rust
npm run test:e2e
npm run test:package -- --out artifacts/release-0.1.12-alpha/npm-final
npm run test:package -- --out artifacts/release-0.1.12-alpha/npm-final --nested
npm run release:verify-artifacts -- --host --directory artifacts/release-0.1.12-alpha/npm-final
```

Windows preparation logs, failure reproductions and archive hashes are under
`artifacts/release-0.1.12-alpha/`. Frozen V5/V6 evidence remains unchanged under
`artifacts/performance-v6/`. Ubuntu validation logs and archive hashes are under
`artifacts/vps-linux-alpha-20261011/`. These ignored local artifacts do not travel with
`git push`; retain/copy them separately when sharing the release evidence.

## Native platform matrix and Linux

**Ubuntu 24.10 x64 validated on 2026-10-11**, with glibc 2.40 and Node 24.19.0.
Installation, application builds, 122 targeted integration tests, the separate
three-application `host` test and both isolated npm installation layouts passed.
The Linux binary was cross-compiled on Windows with Rust 1.98.0, cargo-zigbuild
0.23.4 and Zig 0.13.0; application builds and runtime checks ran on Ubuntu.
The tested main npm archive matched the Windows archive byte for byte. Subsequent
README edits change package bytes, so rebuild and verify the final archives.
Testing used an isolated temporary directory with resource limits on the user's
VPS; existing services were preserved and the temporary test files were removed.
This was functional validation, not a Linux performance or endurance campaign.
macOS and ARM64 validation for this candidate remains pending.

Once the exact candidate is on GitHub, run the existing
six-platform archive workflow with both reuse options disabled. It creates
archives only, tests hoisted/nested installs and never publishes. The manual
Linux alpha workflow runs installation, build, the complete integration suite
(including symlinks, Unix signals, cache, streaming and `host`) and real package
tests without requiring the long performance campaign or a cgroup benchmark.
The existing `performance-linux-v6.yml` remains available for a dedicated
machine; it is not a prerequisite to every alpha.

With GitHub CLI installed/authenticated, from your reviewed pushed branch:

```sh
gh workflow run npm-artifacts.yml --ref main -f reuse-published-native=false -f reuse-published-unix-native=false
gh workflow run release-alpha-linux.yml --ref main
gh run list --workflow npm-artifacts.yml --limit 5
gh run list --workflow release-alpha-linux.yml --limit 5
```

Use the run IDs for **that exact commit**, wait for all jobs, inspect failures,
then collect the six `npm-alpha-*` artifacts into one fresh directory (below,
`artifacts/release-0.1.12-alpha/all-platforms`). Keep the seven archives and all
twelve `verified-*.json` reports. Before merging duplicate framework archives,
compare their hashes: all six must contain identical bytes. Do not overwrite a
different archive/report to make verification pass.

For example, in PowerShell after replacing `RUN_ID` with the successful archive
run (the download and merge are local/read-only toward GitHub):

```powershell
gh run download RUN_ID --dir artifacts/release-0.1.12-alpha/download
$releaseArchives = 'artifacts/release-0.1.12-alpha/all-platforms'
New-Item -ItemType Directory -Path $releaseArchives -ErrorAction Stop
Get-ChildItem artifacts/release-0.1.12-alpha/download -Recurse -File |
  Where-Object { $_.Name -like '*.tgz' -or $_.Name -like 'verified-*.json' } |
  ForEach-Object {
    $destination = Join-Path $releaseArchives $_.Name
    if (Test-Path -LiteralPath $destination) {
      if ((Get-FileHash -LiteralPath $_.FullName).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
        throw "Different artifact bytes: $($_.Name)"
      }
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $destination
    }
  }
```

```sh
npm run release:verify-artifacts -- --directory artifacts/release-0.1.12-alpha/all-platforms
npm view @thomas.f/prnext dist-tags --json
npm view @thomas.f/prnext@0.1.12-alpha version
```

The last query must still report E404. If any native of this version is already
published, compare its exact bytes/integrity to the verified archive; never
attempt an overwrite. Failures in essential platform/package tests block that
platform's publication. Do not advertise an unbuilt native.

## Publication commands — maintainer only, not executed

Run only after the complete archive verification above. Keep npm's `alpha`
tag; do not move `latest` as part of this preparation.

```sh
npm publish artifacts/release-0.1.12-alpha/all-platforms/prnext-darwin-arm64-0.1.12-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.12-alpha/all-platforms/prnext-darwin-x64-0.1.12-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.12-alpha/all-platforms/prnext-linux-arm64-gnu-0.1.12-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.12-alpha/all-platforms/prnext-linux-x64-gnu-0.1.12-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.12-alpha/all-platforms/thomas.f-prnext-win32-arm64-msvc-0.1.12-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.12-alpha/all-platforms/thomas.f-prnext-win32-x64-msvc-0.1.12-alpha.tgz --access public --tag alpha
node packages/prnext/release/verify.mjs
node scripts/release-lock.mjs
npm ci
npm run release:check
npm publish artifacts/release-0.1.12-alpha/all-platforms/thomas.f-prnext-0.1.12-alpha.tgz --access public --tag alpha
npm view @thomas.f/prnext@alpha version
```

The explicit `verify.mjs` step checks that all six matching native versions are
really published before the wrapper, including when publishing a tarball does
not invoke the source package's `prepublishOnly` hook. Commit the updated real
native lock integrity values afterward. The root lockfile is not in the npm
framework tarball; this refresh does not change the tested package bytes.

## Application upgrades

After installing the release, run `prnext build <project>` and restart the
server/host. Rebuild standalone output on its deployment OS/architecture and
replace the whole output. `pstart` users rebuild before `prestart`. Old dynamic
builds lack the required lifecycle contract and deliberately fail before
listening. Do not copy a contract file to old runtime modules. CLI/environment
retirement overrides require a restart; application config/runtime/source
changes require a rebuild. Static-only legacy builds without worker routes or
middleware can still serve files without Node.

See [CHANGELOG.md](CHANGELOG.md) for the reproduced experimental 1 GiB memory
regression, supported configuration options and remaining alpha limits.
