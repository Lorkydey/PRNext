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
