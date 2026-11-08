# Upgrade from 0.1.21-alpha to 0.1.22-alpha

Check [release status](../RELEASE.md) before installing this version. Preserve
your previous source, lockfile, configuration and complete deployment for rollback.

```sh
npm install @thomas.f/prnext@0.1.22-alpha
npx --no-install prnext check --production --json
npx --no-install prnext build
```

Keep optional dependencies enabled. Framework and native packages must both
identify 0.1.22-alpha. Deploy the complete rebuilt application and deliberately
restart its workers; replacing packages underneath a running process is insufficient.
Node and React requirements remain unchanged from 0.1.21-alpha.
For upgrades from older releases, also follow their supervisor and data guidance.

## Automatic compact presentation

No directive is needed. In production Node App Router builds, PRNext recognizes
a conservative subset of synchronous, pure display components and compiles their
static markup into a reusable template. All dynamic expressions, including
arithmetic and branch conditions, execute on the server. Only display results
cross Flight. This does not skip authorization, cache user data or move private
calculations into the browser. Full HTML remains available before JavaScript.

Unsupported syntax, imports, effects, interactive elements, unsafe attributes,
small models and unverified custom compiler pipelines retain ordinary rendering.
Development, Pages, Edge and HTML-only output use their existing paths. A custom
webpack hook, including one installed by a plugin, can conservatively disable
this optimization. Do not remove a needed plugin to increase eligibility.

Read `.prnext/presentation-report.json` after building to inspect compiler
decisions. A compact entry does not guarantee every request uses compact Flight:
runtime values and size checks can still select ordinary rendering. Compare
your own application with `presentationComponents: false` in `prnext.config.mjs`,
then rebuild both variants. The deprecated experimental alias remains compatible;
prefer the top-level setting. Results depend on component shape and workload.

## Verify the actual application

Exercise hydration, navigation, account changes, forms, streaming cancellation
and a browser tab opened before deployment. Retain old hashed assets for those
tabs. Verify rollback with the complete prior deployment and reject stale
mutations without automatically replaying them. Evaluate both latency and bytes;
a smaller Flight payload can add a small template module to browser JavaScript.

A twenty-minute diagnostic is useful evidence for this release but does not
replace the separate two-hour SaaS qualification or longer application pilots.
