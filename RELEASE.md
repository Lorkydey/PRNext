# Preparing 0.1.13-alpha

This is a runtime release, not a metadata-only update. Do not reuse the
0.1.12-alpha native archives: Linux process lifecycle changes require new native
builds as well as the updated JavaScript runtime. Preparation and artifact
workflows do not publish to npm. Check all seven registry versions immediately
before publication; a GitHub push does not update the npm package.

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
npm run test:package -- --out artifacts/release-0.1.13-alpha/npm-final
npm run test:package -- --out artifacts/release-0.1.13-alpha/npm-final --nested
npm run release:verify-artifacts -- --host --directory artifacts/release-0.1.13-alpha/npm-final
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
twelve `verified-*.json` reports. Before merging duplicate framework archives,
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
done < <(find "$download_dir" -type f \( -name '*.tgz' -o -name 'verified-*.json' \) -print0)
```

```sh
npm run release:verify-artifacts -- --directory artifacts/release-0.1.13-alpha/all-platforms
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
import { verifyArtifacts } from './scripts/verify-npm-artifacts.mjs';
const directory = 'artifacts/release-0.1.13-alpha/all-platforms';
await verifyArtifacts({ directory });
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
