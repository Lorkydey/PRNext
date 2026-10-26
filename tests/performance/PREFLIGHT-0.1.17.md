# 0.1.17-alpha release preparation

Local candidate only. Nothing in this validation publishes npm packages, pushes
GitHub changes or updates the hosted production service.

## Development recovery

Run `prnext dev --safe` (or `npx --no-install prnext dev --safe`) from an installed
application to troubleshoot incremental build problems. It compiles the complete
route graph with fresh compilers, disables the persistent transform cache and
does not prewarm application workers. Fast Refresh still preserves compatible
component state. Restart without `--safe` to restore ordinary optimizations.

These checks select the frozen candidate through `PRNEXT_BINARY`. The existing
local demo keeps its older executable open, so its `target/release/prnext.exe`
has not been replaced. To test this candidate from the Windows checkout:

```powershell
$env:PRNEXT_BINARY = (Resolve-Path 'artifacts/preflight-0.1.17-20261024/prnext-final.exe').Path
node packages/prnext/cli.mjs dev path/to/your/app --safe
```

This override applies only to the current terminal. Published-package tests use
the executable extracted from the npm archive instead.

Build diagnostics now explain why work ran: opening a route, changing source,
changing environment/configuration, updating only CSS, or falling back to the
complete compiler. Diagnostics contain no environment values.

The preflight found and fixed two state-loss bugs: anonymous default JSX
components lacked stable Refresh families, and generated Server Action proxies
were treated as unsafe component modules when their reference IDs rotated.
Actual mixed component/value exports still require a page reload.

## Validation procedure

The exact npm archives are installed through an isolated loopback registry into
empty applications with both hoisted and nested dependencies. Checks include
global installation in a temporary prefix containing spaces, both CLI aliases,
local npm execution, migration, production build, standalone relocation, persistent
start/reload/shutdown and development rebuilds. The real user npm prefix is not
modified.

The same native/archive identities must then pass lifecycle tests on official
Node 22.23.4, 24.22.1 and 26.12.1 binaries. The release verification gate requires
all three proofs. The six-platform workflow includes the same checks; local x64
Windows/Linux results do not establish macOS or ARM64 compatibility.

The isolated VPS endurance run lasts 7,200 seconds after four pages hydrate and
their counters reach one. It alternates JavaScript/CSS edits, introduces and
repairs syntax errors, invokes Server Actions, and overlaps rebuilds with streamed
responses and `after()` work that accesses the cache. All tabs must preserve their
document and component state. Samples cover the entire service process tree,
including Node, esbuild and native processes. Budgets: no OOM kill, at most 24
processes, PSS below 1.5 GiB and less than 256 MiB steady-state PSS growth.
A separate filesystem monitor checks retention of three runtime and three style
generations. Startup and failed preliminary probes are retained as evidence.

## Dependency review

- React, React DOM and react-server-dom-webpack remain aligned at 19.3.1,
  a patched version for the October 14
  [RSC remote execution advisory](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3)
  and [Server Functions denial of service advisory](https://github.com/react/react/security/advisories/GHSA-h3gv-c5rc-p453).
- Tokio is updated to 1.53.3 for
  [RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html).
  The affected Unix `AsyncFd` API is not directly used by PRNext; this is not
  evidence of an exploitable PRNext remote execution vulnerability.
- The development lockfile resolves fast-uri 3.1.9, including the fix for
  [CVE-2026-110306](https://github.com/advisories/GHSA-w74x-v6f9-j3xg).
  Published package consumers retain their own dependency lockfiles.
- The Rust advisory scan retains the informational
  [unmaintained paste notice](https://rustsec.org/advisories/RUSTSEC-2024-0436.html).
  There is no patched paste release; the notice is not a demonstrated exploit.

Security checks also exercise exact loopback hosts, session capabilities, origin
restrictions, MCP initialization/disconnection and production rejection of the
development endpoint. Dependency/advisory checks cannot prove an absence of
unknown vulnerabilities.

## Additional framework boundary finding

A synthetic probe confirmed that a module marked `use server` in an `.mts` file
could bypass the framework transform and put its implementation/constants into
browser JavaScript. The action registry remained empty. This is a potential
server-side code disclosure; the proof uses a synthetic marker.

Application graphs now reject React server/client directives in `.mts`/`.cts`
files and direct developers to `.ts`/`.tsx`. The guard uses the existing Rust
source parser, shares cached analyses and checks both original source and
transformed loader input. A loader that removes a directive cannot erase the
original boundary check.
Ordinary TypeScript helpers, CommonJS helpers and decorators remain supported.
Regression cases cover App/Pages graphs, development/production, preservation
of the last valid output and a custom loader.

This guard was added after the long stress snapshot was frozen. The two-hour
workload exercises `.js`/`.jsx` files; its native executable is unchanged. Final
guarded source receives fresh unit/browser checks, exact-archive installation
and lifecycle proofs, plus a separate four-tab VPS smoke run. These scopes must
be distinguished when reporting results.

## Evidence

Raw logs, frozen source manifests, exact binaries, npm archives, preliminary
failures and endurance samples are retained locally under
`artifacts/preflight-0.1.17-20261024/`.

| Check | Final result |
| --- | --- |
| Full JavaScript unit suite | 899 passed, one optional native-addon skip |
| Rust | 186 passed, one existing manual ignore; formatting and warning-free Clippy pass |
| Isolated npm installation | 11 checks per layout/platform: hoisted and nested on Windows/Linux x64 |
| Exact-archive lifecycle | 55 tests per Node/platform combination; all six combinations pass |
| Linux development/production integration | 19 passed, including production rejection of the development endpoint |
| Chromium development scenarios | Seven passed on final guarded source, including unique-response Server Actions |
| TypeScript/release metadata | Three type projects and local release checks pass |
| Dependency review | npm audit reports zero known vulnerabilities; 340 Cargo crates checked, paste maintenance notice retained |

The final framework archive SHA-256 is
`e1a31f2c9004fe9fee829faa97b1a8b53b5ad1ae69cb5a14f34e51d4851096f1`.
All six final lifecycle proofs refer to these exact bytes. The 316 archive
entries match the current package source, including both license files.
Windows executable:
`bd7d498bcd52f474aed518c50dc43a9979a6f127727755bc8d8a1fda7d33c55f`;
Linux executable:
`e0282ce66399134eb37be3574ca8f0389f2c36df6789350dd3180a23cab89aec`.
Final archives and reports are in `npm-v3-windows/` and
`linux-v3-evidence/npm-v3-linux/`. Earlier archive/probe attempts are retained
separately; an initial Linux transfer omitted two license files and was rebuilt.

The first loaded-machine JavaScript run exceeded two test deadlines, and the
first concurrent Rust run exceeded a worker-start deadline. Focused reruns and
fresh complete JavaScript/Rust runs pass without changing the test deadlines.

The temporary parallel PowerShell launcher exposed a null `Process.ExitCode`
even for a successful `node --version`. Independent archive gates pass, and a
direct subprocess rerun confirms actual exit code zero for Node 22, 24 and 26,
with all 55 tests passing on each. Those exit records are retained separately.

The frozen two-hour workload completed in 7,201.38 seconds: 1,738 edits,
28 syntax-error recoveries, 174 verified streams, 174 background/cache checks
and 175 action invocations across four tabs. There were zero page errors and
all counters/documents retained their state. Sampled process-tree PSS peaked at
536.51 MiB; the final five steady-state samples averaged 59.05 MiB above the
first five after warmup. The sampled process count peaked at ten; no OOM kill
was recorded. All configured process-memory budgets pass.

The frozen framework snapshot for that long workload has archive SHA-256
`059e6b93fd14ba81051327ca7cad3e3cf0aaf1cfc08c3a454f02cb0fee7fbfe2`.
The late guard changes four build helper files; runtime files and native
executables are unchanged. The final source also completes a fresh 62.53-second
four-tab VPS run: 14 edits, two verified streams, two background/cache checks,
three action invocations, preserved counter/document state and zero page errors.

The separate filesystem sampler stopped on an intentionally generated error
state and resumed after repair, leaving a 25-minute sampling gap. Primary
process-memory sampling and browser/work assertions continued. Observed runtime
and style retention remain limited to three generations each. Preliminary
sampler failures are retained alongside the measurements.

All temporary VPS services have stopped. Cleanup removes only verified scratch
dependency/cache/build directories under the owned validation directory; source,
archives and logs remain. The five production service PIDs match the baseline;
`prnext.dev`, `app.prnext.dev` and `rblv.lol` return HTTP 200.

macOS x64/ARM64, Linux ARM64 and Windows ARM64 have not been executed in this
local preflight. Their prepared workflow remains a release gate; Windows/Linux
x64 results must not be presented as validation of all six native targets.
