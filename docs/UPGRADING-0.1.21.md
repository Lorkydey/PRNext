# Upgrade from 0.1.20-alpha to the 0.1.21-alpha candidate

0.1.21-alpha is not published on npm yet. These instructions describe the
prepared candidate and apply only after its npm availability is confirmed.
The current published release remains 0.1.20-alpha. Next.js compatibility is
partial, and this candidate is intended for a controlled application pilot.

## Stop the old persistent supervisor before replacing packages

The local supervisor protocol changes in this version. With the still-installed
0.1.20 CLI, in the application directory and under the account that started it,
run:

```sh
npx --no-install prnext pstatus --json
npx --no-install prnext pdown
```

Use the same `PRNEXT_PM_HOME` for both commands and throughout the upgrade.
If you used a global or otherwise separately installed CLI to start the old
supervisor, use that old installation's `pdown` before replacing it. Do not use
the new CLI to stop an old supervisor: it rejects the incompatible protocol.

Plan a maintenance window for every application sharing that home. `pdown`
stops its supervisor and managed applications while retaining their saved
settings and enabled entries. An application-only `prestart` does not reload
the supervisor code. Inspect saved binary paths, health routes and all enabled
applications before starting the new supervisor: its next `pstart` or `prestart`
can restore those enabled applications too. Upgrade/rebuild each installation
that must return with the candidate. A global CLI upgrade alone does not replace
an application's package or native binary.

Do not delete the supervisor home or application databases. Do not stop unrelated
Node processes, databases, Redis, reverse proxies or operating-system services
as an automatic fallback. Other supervisor homes and external services have
their own owners and maintenance procedure. Stop and diagnose if the old CLI
cannot shut down its own supervisor; keep the working deployment available.

## Install matching packages and rebuild

Preserve the previous application source, lockfile, configuration, build output
and compatible database backup for rollback. After publication is confirmed,
run in each application installation being upgraded:

```sh
npm install @thomas.f/prnext@0.1.21-alpha
npx --no-install prnext check --production --json
npx --no-install prnext typecheck
npx --no-install prnext build
npx --no-install prnext output --json
```

Keep native optional dependencies enabled. The framework and selected native
package must both identify 0.1.21-alpha. Node support remains
`^22.23.4 || ^24.22.1 || >=26.12.1`; React, React DOM and
react-server-dom-webpack must all be 19.3.1. Typecheck requires the application's
own TypeScript installation and tsconfig. Restart development sessions too so
their compiler broker and CLI use the same local protocol.

Rebuild with the new runtime. For standalone output, deploy the complete new
standalone directory for the intended platform. An older build or a package
replacement beneath a running worker does not update loaded code. Compiler
cache identities may miss after an upgrade; do not delete runtime data to force
a cache refresh.

## Verify public origin and account boundaries

Keep an explicit canonical HTTPS origin and trust only the immediate upstream
proxies that actually connect to PRNext. For a same-host proxy, merge this with
your existing configuration and replace the example domain:

```js
export default {
  server: {
    publicOrigin: 'https://example.com',
    trustedProxies: ['127.0.0.1', '::1'],
  },
};
```

This candidate applies that trust policy at each native proxy ingress. The
configured origin wins over forwarded host/protocol. Dynamic-origin deployments
must explicitly trust the real upstream and the native-to-backend connection;
do not add broad trusted ranges just to silence a redirect problem. Proxy trust
does not establish a forwarded client-IP chain. Rebuild after changing the saved
configuration and keep backend listeners on their intended private interfaces.

Through the actual public HTTPS endpoint, check `NextRequest.url`, redirects,
sign-in, logout, secure cookies and provider callbacks. Keep application-level
authorization and correctly configured `navigationCache.authCookies`. Exercise
account A → logout → account B, browser history and retained private drafts.

## Start deliberately, observe and retain a rollback path

Use the new installation to restart only the intended saved applications under
the same supervisor home. Check `pstatus --json`, configured read-only health
routes, public pages, authenticated writes, navigation, cancelled streams and
the rollback monitoring window. Confirm process and native versions instead of
relying on a successful initial health probe alone.

If rollback is needed, use the new CLI's `pdown` first, then restore the previous
matching application packages/build and use the old CLI with its preserved home.
Check every restored enabled application. Code rollback does not undo writes or
schema changes; retain compatible migrations and application idempotency.

The [pilot criteria](../COMPATIBILITY.md#qualify-an-application-pilot)
require a pinned candidate, declared objectives, complete monitoring and a
recorded pass/fail/inconclusive decision. A 7–14 day pilot is still pending;
green CI or an earlier two-hour campaign does not mean it has completed.
PRNext Host is a separate deployment with its own backup/restore, authentication
and operational qualification. Updating the npm framework does not deploy Host
or update any external service automatically.
