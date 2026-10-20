# Preparing 0.1.13-alpha

## Unreleased security follow-up (16 October 2026)

The local OG renderer fix is not part of the published 0.1.13-alpha archive.
Prepare a new version with `scripts/release-version.mjs`; do not attempt to
overwrite that published version. The normal native-version and artifact checks
still apply. No new release has been published by this security change.

`npm run release:prepare-og` reproducibly rebuilds the shipped renderer from the
locked `@vercel/og` development dependency and patched fflate 0.7.5. It refuses
an unexpected upstream bundle layout. Review and commit the generated
`packages/prnext/runtime/og/` assets and licenses. `release:check` requires these
assets and refuses the old production dependency or embedded version marker.
Verify a packed archive in a fresh consumer installation, not only the monorepo
lockfile: root overrides are not inherited by consumers. Preserve ImageResponse
rendering, including compressed WOFF fonts, when changing this dependency.

## Original 0.1.13-alpha release preparation

This is a runtime release, not a metadata-only update. Do not reuse the
0.1.12-alpha native archives: Linux process lifecycle changes require new native
builds as well as the updated JavaScript runtime. Preparation and artifact
workflows do not publish to npm. Check all seven registry versions immediately
before publication; a GitHub push does not update the npm package.

## Performance evidence

The October 15 campaign compared a **frozen local 0.1.13-alpha candidate**, not
the public npm release, against Next.js 16.4.1 and TanStack Start 1.169.2
(Router 1.170.44, Vite 8.3.4, Nitro 3.0.260903-beta). Node was 24.22.0;
the application React family was 19.3.0. Next App Router used its bundled React
canary. Nitro's adapter was beta. A separate React 19.3.1 compatibility control
was not the source of these throughput numbers.

Production, one server CPU, identity encoding, five repetitions of 10 seconds
warmup plus 30 seconds measurement. SSR renders 100 rows at 64 connections;
streaming waits 40 ms at 128 connections; JSON returns 16 rows at 64 connections.
Next and PRNext used the same sources; TanStack implemented the same workload
with its own architecture. Response freshness, cookie separation and progressive
streaming were checked. No dynamic page cache was added. Generator CPU was
separate; server CPU includes terminated descendants and RSS sums the process
tree (shared pages can be counted more than once).

| Platform / workload | Next req/s | PRNext balanced req/s | Next / PRNext RSS (MiB) | Next / PRNext CPU per response (ms) |
| --- | ---: | ---: | ---: | ---: |
| Windows / SSR | 281.00 | 364.63 | 362.03 / 181.59 | — |
| Windows / streaming | 558.37 | 564.87 | 375.14 / 212.24 | — |
| Windows / JSON | 2047.37 | 1955.43 | 324.68 / 133.11 | — |
| Linux / SSR | 157.77 | 217.70 | 246.58 / 149.39 | 6.255 / 4.595 |
| Linux / streaming | 277.30 | 437.43 | 251.27 / 163.49 | 3.577 / 2.278 |
| Linux / JSON | 1050.33 | 1415.93 | 224.69 / 126.29 | 0.951 / 0.705 |

Windows: Ryzen 5 3600, 32 GiB, Windows 11 Pro 26100. Linux: shared Ubuntu
26.04 x64 VPS, 8 Haswell-class vCPUs, about 23 GiB usable RAM. Do not compare
absolute throughput across these machines. Windows streaming ranges overlapped;
Windows JSON was slower than Next. TanStack was faster on these App-style
fixtures (Linux SSR/streaming/JSON: 736.87/1006.23/5460.30 req/s). A separate
traditional Pages SSR fixture favored PRNext. This is not universal Next.js
compatibility or a claim to outperform every framework.

Six 30-minute fixed-load endurance runs totaled 2,213,996 ordinary responses
without generator errors, plus separately classified intentional cancellations.
Failed setup/memory-constrained trials were retained and excluded explicitly;
not every attempted test passed. Fifteen-minute idle observations showed PRNext
releasing Node workers, with Linux RSS 11.86 MiB and a 393.62 ms first SSR response;
Next retained 202.99 MiB and responded in 32.94 ms. Those wake latencies are single
observations. An unchanged CPU counter at its sampling resolution means no
measurable CPU over that interval, not guaranteed zero CPU.

The direct Route Handler adapter experiment subsequently improved JSON throughput
by 6.37% on Windows and 7.95% on Linux in three repeated paired controls, with
Linux RSS **increasing** 121.99 → 124.18 MiB. The final shutdown integration is
later again: do not relabel the historical campaign as a benchmark of final
publication bytes. No new performance claim follows merely from passing its
functional release checks.

Retained evidence: `artifacts/framework-comparison-20261015/final/report.html`
(SHA-256 `9f4f580f3c526183132bffb832a39398cc1451bb842e50198bd776ae398b1066`).
Frozen measured executables: Windows
`7ae162f468b6a2b99216f41f96acf579aeae65e441c0008757da53b44e462066`,
Linux `d8f97bf52a474b47349862cf1643e3106a3977d479d027fb2619c4dcc5ca7137`.
The ignored evidence directory must be distributed separately for public
reproduction; it is not included by a Git push or npm publication.

## Versions and lockfile

`node scripts/release-version.mjs 0.1.13-alpha` synchronizes the root workspace,
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
node scripts/release-version.mjs 0.1.13-alpha.1
```

Then rebuild and retest every archive. Do not relabel an old executable.

## Local checks

### October 15 artifact validation

These checks use Rust 1.98.0, Node 22.23.3 and Node 24.22.0. The main npm
archive is identical on both x64 platforms (SHA-256
`3f9b5a456442e1443e4dc640514629b29322ebf5a636de71623a4294cbb7e11a`).
The Linux executable targets glibc 2.28 and was executed on Ubuntu 26.04 x64,
glibc 2.43. The MSVC-target Windows executable was cross-compiled with
cargo-xwin 0.23.1 and Clang 23.1.3, then executed on Windows 11 x64; compilation
alone is not its Windows validation. The private compiler flag for libwebp's
runtime-dispatched SSE4.1 translation units does not change the generic Rust ISA.

| Control | Linux x64 | Windows x64 |
| --- | --- | --- |
| Isolated npm install, hoisted / nested, Node 22 | 10 / 10 checks passed | 10 / 10 checks passed |
| Packaged executable: lifecycle, cache, actions, middleware, routing, Node 22 | 47 passed | 47 passed |
| Same packaged executable, Node 24 | 47 passed | 47 passed |

Linux source checks: 755 unit tests passed, two Windows-only tests skipped;
TypeScript and Clippy passed. Rust: 173 passed, one manual static benchmark
ignored. The release-proof tests also reject missing Node-major results,
changed archive/executable hashes and an unreadable CLI mode. Tests use actual
35-second `after()` callbacks during idle retirement and capacity eviction,
including a cancelled incoming wake, plus active streaming and forced cleanup.
The host memory test deliberately allocates more than its 256 MiB application
budget and checks cooldown and another application's availability.

Executable SHA-256:

- Linux: `27f8c33ad9ef203c18b7d37e51ee572e76bd7e85a9c91aded479ff8314868e6e`
- Windows: `75eb4639fe0864837fbf2619985c22523b6c60b832293934ddfd492dc4627a75`

Local evidence and install/lifecycle proofs are in
`artifacts/alpha-release-20261015/`. Windows checks run in owned, memory-bounded
Jobs; Linux checks use temporary restricted services. These are functional
controls, not new performance measurements. Failed/resource-constrained trials
are retained separately and do not count as passes. No npm publication or
production runtime replacement is included. macOS, ARM64 and the other announced
runner environments still require their own successful artifact jobs; a rebuild
must be verified again because its executable/archive bytes can differ.

The earlier preparation used Node 24.19.0 / npm 11.12.1 / Rust 1.98.0. The
October 15 artifact checks use the versions above. Node 22+ remains the supported
package range; these results do not claim that every Node/OS combination was
tested locally.

For the October 15 release follow-up, use the pinned private Node 22.23.3 and
24.22.0 controls and Rust 1.98.0. Preserve binary and archive SHA-256 values with
the results. Test the exact release executable, not an older file with the same
version string. `test:package -- --binary <file>` packages that executable without
rebuilding it; do not mix this option with `--published-native`.

The release artifact workflow runs shutdown/idle/eviction and supported
`after()` controls on Node 22 and 24 in addition to isolated npm installs.
Windows graceful shutdown is tested through the supervised stdin EOF path;
Windows `TerminateProcess`/`SIGKILL` cannot provide Unix SIGTERM semantics.
macOS and ARM64 still need their own native artifact jobs. Passing x64 tests
does not establish their compatibility, and the main npm package must not be
published ahead of the six verified native archives.

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
npm run test:package -- --out artifacts/release-0.1.13-alpha/npm-final
npm run test:package -- --out artifacts/release-0.1.13-alpha/npm-final --nested
# Run this command once with Node 22, then again with Node 24; keep the same archives:
node scripts/test-release-lifecycle.mjs artifacts/release-0.1.13-alpha/npm-final
npm run release:verify-artifacts -- --host --lifecycle --directory artifacts/release-0.1.13-alpha/npm-final
```

The October 12 source-candidate measurements and checks are under
`artifacts/profile-optimization-20261012/` and
`artifacts/cpu-optimization-20261012/`. They precede the release version bump;
they do not replace verification of the final seven npm archives.

Historical 0.1.12-alpha Windows preparation logs and archive hashes are under
`artifacts/release-0.1.12-alpha/`. Frozen V5/V6 evidence remains unchanged under
`artifacts/performance-v6/`. Ubuntu validation logs and archive hashes are under
`artifacts/vps-linux-alpha-20261011/`. These ignored local artifacts do not travel with
`git push`; retain/copy them separately when sharing the release evidence.

## Native platform matrix and Linux

**Previous 0.1.12-alpha preparation:** Ubuntu 24.10 x64 was validated on
2026-10-11, with glibc 2.40 and Node 24.19.0.
Installation, application builds, 122 targeted integration tests, the separate
three-application `host` test and both isolated npm installation layouts passed.
The Linux binary was cross-compiled on Windows with Rust 1.98.0, cargo-zigbuild
0.23.4 and Zig 0.13.0; application builds and runtime checks ran on Ubuntu.
The tested main npm archive matched the Windows archive byte for byte. Subsequent
README edits change package bytes, so rebuild and verify the final archives.
Testing used an isolated temporary directory with resource limits on the user's
VPS; existing services were preserved and the temporary test files were removed.
This was functional validation, not a Linux performance or endurance campaign.
These historical results do not validate the new 0.1.13-alpha archive bytes.
The new six-platform archive matrix and Linux release checks must pass on the
exact versioned candidate before publication.

Once the exact candidate is on GitHub, run the existing
six-platform archive workflow with both reuse options disabled. It creates
archives only, tests hoisted/nested installs and never publishes. The manual
Linux alpha workflow runs installation, build, the complete integration suite
(including symlinks, Unix signals, cache, streaming and `host`) and real package
tests without requiring the long performance campaign or a cgroup benchmark.
The existing `performance-linux-v6.yml` remains available for a dedicated
machine; it is not a prerequisite to every alpha.

With GitHub CLI installed/authenticated, from your reviewed pushed branch
(these commands also work in Terminal on the maintainer's Mac):

```sh
gh workflow run npm-artifacts.yml --ref main -f reuse-published-native=false -f reuse-published-unix-native=false
gh workflow run release-alpha-linux.yml --ref main
gh run list --workflow npm-artifacts.yml --limit 5
gh run list --workflow release-alpha-linux.yml --limit 5
```

Use the run IDs for **that exact commit**, wait for all jobs, inspect failures,
then collect the six `npm-alpha-*` artifacts into one fresh directory (below,
`artifacts/release-0.1.13-alpha/all-platforms`). Keep the seven archives and all
twelve `verified-*.json` and twelve `lifecycle-*.json` reports. Before merging duplicate framework archives,
compare their hashes: all six must contain identical bytes. Do not overwrite a
different archive/report to make verification pass.

On the Mac, use a checkout of that exact commit, Node 22+ and an authenticated
GitHub CLI. Replace `RUN_ID` below with the successful archive run ID, and
confirm its `headSha` matches `git rev-parse HEAD`. Use a fresh download and
merge directory; do not repack or rebuild the downloaded archives on the Mac.
Run the following command blocks in Bash (`bash` in Terminal).

```bash
set -euo pipefail
RUN_ID=REPLACE_WITH_SUCCESSFUL_RUN_ID
gh run view "$RUN_ID" --json headSha,conclusion,url
test "$(gh run view "$RUN_ID" --json headSha --jq .headSha)" = "$(git rev-parse HEAD)"
test "$(gh run view "$RUN_ID" --json conclusion --jq .conclusion)" = success
download_dir=artifacts/release-0.1.13-alpha/download
release_dir=artifacts/release-0.1.13-alpha/all-platforms
test ! -e "$download_dir"
test ! -e "$release_dir"
gh run download "$RUN_ID" --pattern 'npm-alpha-*' --dir "$download_dir"
mkdir "$release_dir"
while IFS= read -r -d '' file; do
  destination="$release_dir/$(basename "$file")"
  if test -e "$destination"; then
    cmp "$file" "$destination"
  else
    cp "$file" "$destination"
  fi
done < <(find "$download_dir" -type f \( -name '*.tgz' -o -name 'verified-*.json' -o -name 'lifecycle-*.json' \) -print0)
```

```sh
npm run release:verify-artifacts -- --lifecycle --directory artifacts/release-0.1.13-alpha/all-platforms
npm view @thomas.f/prnext dist-tags --json
```

Confirm that all seven versions are still unpublished (HTTP 404):

```bash
node --input-type=module <<'NODE'
import { packageManifest, platforms } from './packages/prnext/native/resolve.mjs';
for (const name of [packageManifest.name, ...platforms.map(target => target.package)]) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${packageManifest.version}`, { signal: AbortSignal.timeout(15000) });
  if (response.status !== 404) throw new Error(`${name}: expected unpublished version, received ${response.status}`);
}
NODE
```

If resuming an interrupted publication, compare any already-published native's
exact bytes/integrity to the verified archive and skip only those identical
archives; never attempt an overwrite. Failures in essential platform/package
tests block publication. Do not advertise an unbuilt native.

## Publication commands — maintainer only, not executed

Run only after the complete archive verification above. Keep npm's `alpha`
tag; do not move `latest` as part of this preparation. On the publishing Mac,
check `npm whoami --registry=https://registry.npmjs.org/` and use `npm login`
if necessary. Complete npm's own browser/2FA prompts; do not copy credentials
into the repository. Publishing these tarballs from macOS publishes all six
tested native targets, not just the Mac binary.

```sh
npm publish artifacts/release-0.1.13-alpha/all-platforms/prnext-darwin-arm64-0.1.13-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.13-alpha/all-platforms/prnext-darwin-x64-0.1.13-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.13-alpha/all-platforms/prnext-linux-arm64-gnu-0.1.13-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.13-alpha/all-platforms/prnext-linux-x64-gnu-0.1.13-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.13-alpha/all-platforms/thomas.f-prnext-win32-arm64-msvc-0.1.13-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.13-alpha/all-platforms/thomas.f-prnext-win32-x64-msvc-0.1.13-alpha.tgz --access public --tag alpha
```

Before publishing the wrapper, download each native from npm and compare its
exact bytes with the verified local archive. This fails on any difference:

```bash
node --input-type=module <<'NODE'
import { platforms } from './packages/prnext/native/resolve.mjs';
import { publishedNative } from './scripts/test-package.mjs';
import { verifyArtifacts, verifyLifecycleArtifacts } from './scripts/verify-npm-artifacts.mjs';
const directory = 'artifacts/release-0.1.13-alpha/all-platforms';
await verifyArtifacts({ directory });
await verifyLifecycleArtifacts({ directory });
for (const target of platforms) await publishedNative({ out: directory, target });
NODE
node packages/prnext/release/verify.mjs
node scripts/release-lock.mjs
npm ci
npm run release:check
npm publish artifacts/release-0.1.13-alpha/all-platforms/thomas.f-prnext-0.1.13-alpha.tgz --access public --tag alpha
npm view @thomas.f/prnext@alpha version
```

The explicit `verify.mjs` step checks that all six matching native versions are
really published before the wrapper, including when publishing a tarball does
not invoke the source package's `prepublishOnly` hook. Commit the updated real
native lock integrity values afterward. The root lockfile is not in the npm
framework tarball; this refresh does not change the tested package bytes.

## Application upgrades

After installing the release, run `prnext build <project>` and restart the
server/host so the new runtime modules are included. Rebuild standalone output
on its deployment OS/architecture and replace the whole output. `pstart` users
rebuild before `prestart`. Dynamic builds predating the lifecycle contract are
rejected before listening; do not copy a contract file to old runtime modules.
CLI/environment retirement overrides require a restart; application config/runtime/source
changes require a rebuild. Static-only legacy builds without worker routes or
middleware can still serve files without Node.

See [CHANGELOG.md](CHANGELOG.md) for the reproduced experimental 1 GiB memory
regression, supported configuration options and remaining alpha limits.
