# Security policy

## Runtime updates

PRNext 0.1.16-alpha requires React, React DOM and react-server-dom-webpack 19.3.1
together. Earlier releases pinned the affected 19.3.0 RSC runtime. This addresses
[GHSA-xqc2-xf4c-x3h3](https://github.com/react/react/security/advisories/GHSA-xqc2-xf4c-x3h3)
and [GHSA-h3gv-c5rc-p453](https://github.com/react/react/security/advisories/GHSA-h3gv-c5rc-p453).
Update all three peers, rebuild applications, and replace running deployments.
An empty npm audit report does not override the upstream advisories. The Rust
HTTP server does not remove vulnerabilities in the JavaScript RSC runtime.

Use a supported Node.js release with the October 21, 2026 security fixes:
22.23.4+, 24.22.1+ or 26.12.1+ within their respective release lines.
Updating npm dependencies does not update the Node executable. Rebuild container
images and restart running services after updating their runtime.

## Dependency monitoring and response

The dependency security workflow runs daily, on demand and for dependency or
vendored-source changes. It audits all four committed npm lockfiles, `Cargo.lock`
and the explicit component inventories of Fontkit, the OG renderer and NFT.
Vendored files must match their reviewed checksums before current npm advisory
queries run. The OG inventory includes upstream embedded packages that a normal
application lockfile cannot describe.

High and critical npm findings, Cargo vulnerability advisories and incomplete
audits fail the corresponding job. Lower-severity npm findings and Cargo
maintenance notices remain in the sanitized reports for triage. A registry or
advisory-service outage is an incomplete result, not a clean security result.
Check the [dependency security runs](https://github.com/Lorkydey/PRNext/actions/workflows/security.yml)
and enable repository notifications for failed Actions runs.

Dependabot proposes weekly npm, Cargo and Actions updates. First-party native
package versions remain coordinated by PRNext releases. Review vendor changes
explicitly: update their source pins and licenses, inspect current advisories,
regenerate the bundle and its provenance, then run the relevant tests and
archive checks. The workflow never rewrites pins, suppresses findings or applies
updates automatically.

For a new alert, first identify the affected published versions and whether the
vulnerable path is reachable. Prepare a focused fix in a branch, test the actual
artifact and its supported platforms, and document any temporary mitigation and
remaining exposure. Coordinate disclosure privately when needed. Rebuild and
restart affected applications after updating dependencies or a runtime; a
successful audit of the repository does not update a running deployment.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Lorkydey/PRNext/security/advisories/new).
If you cannot use GitHub, email **contact@heythomas.dev** with the subject
**PRNext security report**.

Please report vulnerabilities privately instead of opening a public issue or PR.
Include the affected version or commit, your operating system and Node.js version,
the potential impact, and a minimal reproduction or proof of concept. Redact
credentials and personal data; use a test environment for reproductions.

We will review the report and coordinate investigation, a fix and disclosure with
you. Do not publish exploit details while that coordination is in progress.

## Supported versions

PRNext is an early alpha. Security fixes are developed on the current `main`
branch and shipped in new versions. Older alpha releases do not receive separate
backports.

Reports about the latest npm `alpha` version and the current development version
are welcome. A GitHub source prerelease may precede npm publication; check the
[release notes](https://github.com/Lorkydey/PRNext/releases) and
[release status](RELEASE.md) for availability and known limitations.

## Security assurance and release decisions

A passing dependency audit covers the inventories and advisory data checked at
that time. It does not prove that application authorization is correct or that
the framework has no vulnerabilities. Source review, regression tests, artifact
checks and deployed-service verification are distinct forms of evidence. Keep
their candidate version, scope, date and limitations together; do not carry a
review result forward to changed code without assessing the change.

Record incomplete or excluded security-review areas explicitly. They remain
unassessed, rather than passing. Before expanding a pilot to broader production,
the service owner should arrange an appropriately authorized independent review
of security-sensitive paths in the actual candidate: session and account
boundaries, server-side mutations, public origin/proxy trust, upload/extraction,
local control interfaces, and the Host authorization/approval boundary when used.
Testing must use an authorized environment and disposable data. This policy does
not authorize testing PRNext Host or another person's deployment.

For a privately reported issue, triage should distinguish confirmed impact from
a conditional lead, identify affected published versions and prerequisites,
and determine whether a temporary mitigation is usable. Preserve a regression
test for confirmed behavior when feasible. Communicate affected versions, the
fixed version or available mitigation, required operator action and any remaining
limitations through the coordinated advisory and release notes. Do not describe
a source fix as deployed or an unpublished fix as available on npm.

There is no guaranteed acknowledgement or remediation deadline. Do not wait for
a PRNext package release to apply an upstream runtime or operating-system fix
that your deployment needs. The application owner remains responsible for its
Node executable, proxy, database, secrets, backups and host OS. See the
[alpha maintenance and pilot contract](COMPATIBILITY.md#alpha-compatibility-and-maintenance-contract)
before depending on an alpha in production.
