# Releases

## GitHub releases

Create a matching `v<VERSION>` tag and GitHub release for each new released
version after its source has passed the required PR checks and is merged into
`main`. Pin the tag to the verified commit and include the relevant changelog,
upgrade steps, limitations and npm availability. Keep existing release tags
unchanged.

Versions such as `0.1.17-alpha` are GitHub **prereleases**. A source prerelease
contains GitHub's source archives; attach native binaries or npm tarballs only
when the exact files have passed the release checks below. Do not reuse receipts
from different source or archive hashes.

Publishing a GitHub release does not publish to npm. If npm is not ready, say so
at the top of the release notes and show the actual published npm version. Update
the notes after npm publication is verified. The README npm badge follows the
registry's `alpha` tag automatically.

The current npm prerelease is `@thomas.f/prnext@0.1.17-alpha`, published on
26 October 2026 with all six matching native packages. The framework's `alpha`
tag selects this release; `latest` remains `0.1.16-alpha`. An unversioned install
therefore still selects 0.1.16-alpha. To use this prerelease explicitly:

```sh
npm i @thomas.f/prnext@alpha
```

The seven release archives passed the six-platform checks recorded below.
GitHub tag/release availability is separate from npm availability.

## 0.1.17-alpha - performance and development

This version adds requested-route development compilation, a stable Rust dev
listener, persistent dev caches, native Lightning CSS processing, background
TypeScript checks and opt-in typed routes. Middleware, rewrites and
parallel/intercepting routes retain complete development graphs.

Production changes include persistent transformation/runtime-bundle and Node/V8
worker caches, a Rust `pstart` proxy, indexed dynamic routing and precompressed
Brotli assets. Incremental build sessions, selected Rust/Oxc analyses, browser
bundle reports/budgets, opt-in worker preloading, post-switch rollback and HTTP/1
WebSocket tunnels are included as well.

The final increments make loader caches failure-tolerant, retain bounded Webpack
development compilers, publish affected CSS bundles selectively and transfer large
HMR dependency graphs as atomic bounded transactions. Installation diagnostics,
independent `typegen`/`typecheck`, workspace-aware npm/pnpm/Yarn migration and
per-route analysis regression budgets are included. SSR diagnostics expose fixed
stage outcomes and resource occupancy; queue waits are configurable, and the
absolute HTTP deadline is opt-in (`PRNEXT_REQUEST_TIMEOUT_MS=0` by default).

The npm package now includes [AI.md](packages/prnext/AI.md) and six focused guides.
`prnext docs --ai` reads documentation for the installed version without a native
binary or network access. `prnext docs --ai --init` explicitly adds a reference
to an application's existing `AGENTS.md`; installation itself changes no project
instructions. Development tools also include the console, inspector, device
previews and local MCP tools with observed build/browser verification.

The source was merged through [PR #18](https://github.com/Lorkydey/PRNext/pull/18)
at `7a0bfc16596c739f65618b7b4188a6f1377371a1`, whose tree is identical to the final
tested source `6064a6dbb357d3873728079d0680f066a96ef3c9`.
The [required CI](https://github.com/Lorkydey/PRNext/actions/runs/40382668882)
passed all 14 jobs on that final source, including native builds, unit/type
checks, integration tests and browser tests on Windows, Linux and macOS.

The [fresh native archive matrix](https://github.com/Lorkydey/PRNext/actions/runs/40355448636)
validated macOS x64/ARM64, Linux GNU x64/ARM64 and Windows MSVC x64/ARM64.
The exact seven archives have twelve hoisted/nested installation receipts and
eighteen lifecycle receipts on Node 22.23.4, 24.22.1 and 26.12.1.
The [full Linux release checks](https://github.com/Lorkydey/PRNext/actions/runs/40355453474)
also passed: 969 JavaScript tests, 200 Rust tests and 354 integration tests;
eight JavaScript skips and one ignored manual Rust benchmark
are recorded separately.

Those archives contain runtime source `69dc7b540131399cecb630e267405779c07dc05e`.
An explicit source-equivalence proof checks that only six validation files changed
before the final tested source: all 1,062 other Git entries, including package,
Rust, dependency, workflow and lifecycle inputs, remain identical through every
intermediate commit. Archive verification matches 332 framework files to their
committed Git blobs and all six native executables to their build receipts.
These proofs and the unchanged archive/install/lifecycle receipts are retained in
`artifacts/npm-launch-20261026/`; they apply only to their recorded hashes.
The [optimization report](tests/performance/NPM-IMPROVEMENTS-20261026.md) and
[earlier preflight](tests/performance/PREFLIGHT-0.1.17.md) remain historical
snapshots, rather than substitutes for this final release verification.

Use Node `^22.23.4 || ^24.22.1 || >=26.12.1` and the aligned React, React DOM and
react-server-dom-webpack 19.3.1 peers. Keep optional native dependencies enabled.
Next.js compatibility remains partial; consult [COMPATIBILITY.md](COMPATIBILITY.md).
Historical benchmark results below are not measurements of the final 0.1.17
publication bytes. No general performance multiplier is claimed for this launch.

## Previous published release - 22 October 2026

On 22 October 2026, `@thomas.f/prnext@0.1.16-alpha` and all six matching native
packages were published to npm; the framework's `alpha` tag then selected that
version. Public registry archives were verified byte-for-byte against the
archives that passed the six-platform release checks. A fresh registry
installation also passed native binary verification, React 19.3.1 resolution,
an App Router build, production SSR and dynamic RSC checks.

Version 0.1.16-alpha requires React, React DOM and react-server-dom-webpack
19.3.1 together, fixing the October 14 React Server Components advisories.
Update all three peers, rebuild applications and replace deployed artifacts.
App Router builds reject an old or mixed React family. Release validation also
rejects vulnerable React versions even when npm audit returns no findings.

The 0.1.15-alpha TLS, image renderer and patched Node requirements remain.
Application-specific Next.js/sharp dependencies and Node executables must still
be reviewed separately; the PRNext npm package does not replace those services.

## Historical source release — 0.1.14-alpha

Version 0.1.14-alpha adds a versioned static build adapter, exclusive build
publication, static gzip precompression and sampled inspector/OTLP diagnostics.
The source also includes the latest main-branch credential-path, local-image,
stdio-drain and browser-observation fixes. Next.js compatibility remains partial.

At that source release, the npm alpha tag still pointed to 0.1.13-alpha;
the GitHub 0.1.14-alpha source prerelease was separate from npm availability.
This historical status is superseded by the later npm publications recorded above.
Its Node 22/24 checks certify only their recorded hashes, not 0.1.17-alpha.
The current publication procedure below requires Node 22/24/26 receipts.

The inspector's OTLP/JSON export is a bounded snapshot of response-header timings,
using the custom `prnext.http.response.headers.duration` metric in seconds. It is
not a continuously exported complete-response or billing metric.


## Historical security follow-up (16 October 2026)

At this point, the local OG renderer fix was not part of the published
0.1.13-alpha archive. It required a new version rather than overwriting the
published archive. This was a preparation note, not a publication receipt.

`npm run release:prepare-og` reproducibly rebuilds the shipped renderer from the
locked `@vercel/og` development dependency and patched fflate 0.7.5. It refuses
an unexpected upstream bundle layout. Review and commit the generated
`packages/prnext/runtime/og/` assets and licenses. `release:check` requires these
assets and refuses the old production dependency or embedded version marker.
Verify a packed archive in a fresh consumer installation, not only the monorepo
lockfile: root overrides are not inherited by consumers. Preserve ImageResponse
rendering, including compressed WOFF fonts, when changing this dependency.

## Historical 0.1.13-alpha release preparation

This was a runtime release, not a metadata-only update. Its Linux process
lifecycle changes required fresh native builds rather than reuse of 0.1.12
archives. The evidence below remains tied to those historical bytes.

## Historical performance evidence — 15 October 2026

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

The current npm prerelease is versioned `0.1.17-alpha`; its published versions
are immutable. For a future release,
`node scripts/release-version.mjs <new-alpha-version>` synchronizes the root workspace,
framework manifest, all six optional native versions, Cargo and both lockfiles.
It refuses existing registry versions. Native packages are generated from
`packages/prnext/native/platforms.json` by the existing packaging command.

Before future native archives are published, their lock entries contain exact
versions, registry URLs and platform constraints, but **no invented or reused
integrity hashes**. Missing unpublished optional natives are expected in a source
checkout; contributors must build Rust. Consumer installation is tested separately
against the actual produced archives through a temporary loopback registry. After publishing the natives,
`node scripts/release-lock.mjs` fills the real registry integrity values. Do not
remove the six entries or regenerate the lock from a platform-pruned install.

For a later version collision, select the next free alpha version with:

```sh
node scripts/release-version.mjs 0.1.17-alpha.1
```

Then rebuild and retest every archive. Do not relabel an old executable.

## Local checks

### Historical October 15 artifact validation

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
October 15 artifact checks use the versions above. They do not establish support
for every Node/OS combination, nor replace the current patched Node engine range.

### Current 0.1.17-alpha checks

Use Rust 1.98.0 and patched Node 22.23.4, 24.22.1 and 26.12.1 controls. Preserve
source commit, executable and archive SHA-256 values with the results. Test the
exact release executable, not an older file with the same version string.
`test:package -- --binary <file>` packages that executable without rebuilding it;
do not mix this option with `--published-native`.

The release artifact workflow runs shutdown/idle/eviction and supported
`after()` controls on Node 22, 24 and 26 in addition to isolated npm installs.
Windows graceful shutdown is tested through the supervised stdin EOF path;
Windows `TerminateProcess`/`SIGKILL` cannot provide Unix SIGTERM semantics.
For 0.1.17-alpha, all six native targets passed these checks with the three Node
versions above. These receipts do not certify a later rebuild or another Node/OS
combination. Future releases still require each native target's own successful
artifact job; the main npm package must not be published ahead of the six verified
native archives.

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
npm run test:browser
npm run test:package -- --out artifacts/release-0.1.17-alpha/npm-final
npm run test:package -- --out artifacts/release-0.1.17-alpha/npm-final --nested
# Run once each with Node 22, 24 and 26, keeping the same archives:
node scripts/test-release-lifecycle.mjs artifacts/release-0.1.17-alpha/npm-final
npm run release:verify-artifacts -- --host --lifecycle --directory artifacts/release-0.1.17-alpha/npm-final
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
These historical results do not validate the 0.1.17-alpha archive bytes.
The successful six-platform matrix and Linux release checks for 0.1.17-alpha are
recorded above. The procedure below documents preparation for a future release;
select its exact version and commit rather than reusing these published archives.

Once a future release candidate is on GitHub, run the existing
six-platform archive workflow with both reuse options disabled. It creates
archives only, tests hoisted/nested installs and never publishes. The manual
Linux alpha workflow runs installation, build, the complete integration suite
(including symlinks, Unix signals, cache, streaming and `host`) and real package
tests without requiring the long performance campaign or a cgroup benchmark.
The existing `performance-linux-v6.yml` remains available for a dedicated
machine; it is not a prerequisite to every alpha.

With GitHub CLI installed/authenticated, select the reviewed branch or `main`
at the exact merged commit intended for release. The commands below prepare
archives only; they do not authorize or perform publication. These commands also
work in Terminal on the maintainer's Mac:

```sh
gh workflow run npm-artifacts.yml --ref YOUR_VERIFIED_BRANCH -f reuse-published-native=false -f reuse-published-unix-native=false
gh workflow run release-alpha-linux.yml --ref YOUR_VERIFIED_BRANCH
gh run list --workflow npm-artifacts.yml --limit 5
gh run list --workflow release-alpha-linux.yml --limit 5
```

Use the run IDs for **that exact commit**, wait for all jobs, inspect failures,
then collect the six `npm-alpha-*` artifacts into one fresh directory (below,
`artifacts/release-0.1.17-alpha/all-platforms`). Keep the seven archives and all
twelve `verified-*.json` and eighteen `lifecycle-*.json` reports. Before merging duplicate framework archives,
compare their hashes: all six must contain identical bytes. Do not overwrite a
different archive/report to make verification pass.

On the Mac, use a checkout of that exact commit, a supported patched Node and an
authenticated GitHub CLI. Replace `RUN_ID` below with the successful archive run ID, and
confirm its `headSha` matches `git rev-parse HEAD`. Use a fresh download and
merge directory; do not repack or rebuild the downloaded archives on the Mac.
Run the following command blocks in Bash (`bash` in Terminal).

```bash
set -euo pipefail
RUN_ID=REPLACE_WITH_SUCCESSFUL_RUN_ID
gh run view "$RUN_ID" --json headSha,conclusion,url
test "$(gh run view "$RUN_ID" --json headSha --jq .headSha)" = "$(git rev-parse HEAD)"
test "$(gh run view "$RUN_ID" --json conclusion --jq .conclusion)" = success
download_dir=artifacts/release-0.1.17-alpha/download
release_dir=artifacts/release-0.1.17-alpha/all-platforms
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
npm run release:verify-artifacts -- --lifecycle --directory artifacts/release-0.1.17-alpha/all-platforms
npm view @thomas.f/prnext dist-tags --json
```

Before a new publication, confirm that all seven selected versions are still
unpublished (HTTP 404). This check intentionally fails for the already published
0.1.17-alpha; do not attempt to overwrite it:

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

## Publication procedure — maintainer only

The commands below record the native-first publication procedure for
0.1.17-alpha. They are not instructions to publish this immutable version again.
For a future release, change the version and archive paths only after producing
and validating its own exact archives.

Run only after a separate decision to publish, the required PR checks and merge,
and complete source, exact-archive, installation and lifecycle verification of
the release commit. Finish every local check before requesting npm's short-lived
publication authorization. The following checks do not require publication:

```bash
node packages/prnext/release/verify.mjs --local
node --input-type=module <<'NODE'
import { verifyArtifacts, verifyLifecycleArtifacts } from './scripts/verify-npm-artifacts.mjs';
const directory = 'artifacts/release-0.1.17-alpha/all-platforms';
await verifyArtifacts({ directory });
await verifyLifecycleArtifacts({ directory });
NODE
```

Keep npm's `alpha` tag; do not move `latest` as part of an alpha publication.
Check `npm whoami --registry=https://registry.npmjs.org/` on the publishing
machine and use `npm login` if necessary. Complete npm's own browser/2FA prompts;
do not copy credentials into the repository.

Once the five-minute publication grant is active, upload all seven already
verified tarballs consecutively: the six natives first, then the framework
wrapper. Do not download public archives, refresh the lockfile, run `npm ci`,
build or insert other verification between uploads. Those checks follow the
complete upload batch. Publishing these tarballs covers all six tested native
targets, regardless of the publishing machine's OS or architecture.

```sh
npm publish artifacts/release-0.1.17-alpha/all-platforms/prnext-darwin-arm64-0.1.17-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.17-alpha/all-platforms/prnext-darwin-x64-0.1.17-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.17-alpha/all-platforms/prnext-linux-arm64-gnu-0.1.17-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.17-alpha/all-platforms/prnext-linux-x64-gnu-0.1.17-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.17-alpha/all-platforms/thomas.f-prnext-win32-arm64-msvc-0.1.17-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.17-alpha/all-platforms/thomas.f-prnext-win32-x64-msvc-0.1.17-alpha.tgz --access public --tag alpha
npm publish artifacts/release-0.1.17-alpha/all-platforms/thomas.f-prnext-0.1.17-alpha.tgz --access public --tag alpha
```

After all seven uploads, wait for registry processing, download each native and
compare its exact bytes with the verified local archive. This fails on any
difference; an accepted upload alone does not establish verified availability:

```bash
node --input-type=module <<'NODE'
import { platforms } from './packages/prnext/native/resolve.mjs';
import { publishedNative } from './scripts/test-package.mjs';
const directory = 'artifacts/release-0.1.17-alpha/all-platforms';
for (const target of platforms) await publishedNative({ out: directory, target });
NODE
node packages/prnext/release/verify.mjs
```

Download the framework archive from its registry metadata and compare it
byte-for-byte with the verified wrapper as well. Only after all seven public
archives and matching native metadata pass verification, refresh the lockfile
with real registry integrity values and validate the checkout:

```sh
node scripts/release-lock.mjs
npm ci
npm run release:check
npm view @thomas.f/prnext@alpha version
```

The explicit `verify.mjs` step checks that all six matching native versions are
really available after the batch, including when publishing a tarball does not
invoke the source package's `prepublishOnly` hook. The package verifier and
required CI protections remain enforced; the procedure changes their order,
not their requirements. Commit the updated real native lock integrity values
through a pull request. The root lockfile is not in the npm framework tarball;
this refresh does not change the tested package bytes. Finally, perform a fresh
public-registry installation and application smoke check. Record the verified npm
version in the GitHub prerelease notes only after these checks pass.

## Application upgrades

Install the intended published alpha and the aligned React, React DOM and RSC
19.3.1 peers with optional native dependencies enabled. Use the supported patched
Node range above. For TypeScript applications, run `prnext typecheck` separately;
`prnext check` does not establish semantic type correctness or browser behavior.
Use `.ts`/`.tsx` for React server/client directives: `.mts`/`.cts` boundaries are
now rejected before build activation. Start with `prnext dev --safe` when
diagnosing incremental development behavior.

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
