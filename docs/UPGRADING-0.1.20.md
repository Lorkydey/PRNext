# Upgrade from 0.1.19-alpha to 0.1.20-alpha

PRNext 0.1.20-alpha is available on npm. See
[the release notes](../RELEASE.md) for its scope and compatibility limits.
Next.js compatibility remains partial.

## Install matching versions and rebuild

Keep your application source, lockfile and current deployment available for
rollback.

For persistent apps started with `pstart`, plan a maintenance window for every
app sharing the same `PRNEXT_PM_HOME`. Before replacing installed packages, run
`npx --no-install prnext pdown` with that same home. This stops the supervisor
and all its managed apps, preserving saved settings and enabled entries. An
application-only `prestart` does not reload the supervisor's code. Update and
rebuild each installation that must return with 0.1.20 before launching the new
CLI: its next `pstart` or `prestart` also restores all enabled entries. Saved
binary paths and health routes remain unchanged; verify them and the restored
apps with `pstatus` and real health requests. A global CLI update alone does not
update each app's package or binary. Use separate homes for independent lifecycles.

Run in the application directory:

```sh
npm install @thomas.f/prnext@0.1.20-alpha
npx --no-install prnext check --production --json
npx --no-install prnext typecheck
npx --no-install prnext build
npx --no-install prnext output --json
```

Keep optional native dependencies enabled. The framework and selected native
package must have the same version. PRNext requires Node
`^22.23.4 || ^24.22.1 || >=26.12.1`, with React, React DOM and
react-server-dom-webpack all at 19.3.1. The explicit typecheck needs your
application's TypeScript installation and tsconfig.

Rebuild with the new runtime and restart the server; replacing only the package
under a running worker does not update its loaded code. For standalone output,
deploy the complete newly generated standalone directory for the target platform.
Keep only that output in the deployment rather than copying the ordinary build
beside it. Verify the selected artifact before switching traffic.

A build from an older version is not a substitute for rebuilding. Existing
compiler records can be reused only when their identities and checksums match;
incompatible or corrupt records are cache misses. There is no need to delete
runtime data to perform the upgrade.

## Set the public HTTPS origin and proxy trust

For a proxy on the same host, merge these settings into your existing config:

```js
export default {
  server: {
    publicOrigin: 'https://example.com',
    trustedProxies: ['127.0.0.1', '::1'],
  },
};
```

Replace the example domain and proxy addresses. `publicOrigin` is an origin
without a path, query, fragment or credentials. It takes precedence when PRNext
constructs request URLs and redirects. Trust only IP addresses or CIDR networks
of proxies that connect directly to PRNext; a forwarded header cannot make an
untrusted peer trusted. This does not establish a forwarded client-IP chain.
Bind the application to loopback or the intended private interface behind the proxy.

Rebuild after changing deployment configuration. `prnext start` reads the build's
saved settings rather than reevaluating source configuration. Over the real
public HTTPS origin, check `NextRequest.url`, middleware redirects, sign-in,
logout, secure cookies and provider callbacks. Update your authentication
provider's allowed URLs when changing the public domain.

## Make account changes reset private client state

List the actual session-cookie names from your authentication library, including
its secure variants:

```js
export default {
  navigationCache: {
    authCookies: ['session-cookie-name', '__Secure-session-cookie-name'],
  },
};
```

Merge this with the preceding config rather than adding a second config file.
PRNext does not infer your authentication scheme from cookie names. Continue to
authorize protected reads and mutations on the server.

With this strict policy, a changed or unknown account identity requires a new
document before retained layouts or pages are adopted. A verified same-account
identity can keep its draft. PPR previews wait for fresh identity; wholly static
models have no live identity and use a document request. Browser history
restoration also reauthorizes before revealing the old document.

Test account A → sign out → account B in one tab, retained pages and browser
history. Confirm that A's private draft, layout props and cached preview never
appear for B. Have private pages observe the authenticated server session so
their live model can carry its identity. See the
[deployment guide](../packages/prnext/docs/ai/deployment.md#production-preflight).

## Use a dedicated application health route

`/_prnext/health` is now a reserved native readiness endpoint. It returns a
complete HTTP 200 JSON response only while the server can accept traffic and
becomes unavailable as draining starts. It does not prove that a lazy Node worker,
your database or external services are ready.

For those dependencies, provide an anonymous, read-only application route such
as `/api/health`. Return a small complete 200 response when the dependencies
needed to serve traffic work, or 503 otherwise. Return no secrets or user data.
Configure that route as `pstart`'s `--health-path`.

Health probes no longer accept redirects or truncated responses. Previously
saved persistent applications retain their saved path, including `/`. If that
path redirects to sign-in, stop and recreate its persistent settings with the
dedicated health route during your planned deployment.

Keep the default post-switch rollback window enabled unless you deliberately
choose another policy. A successful initial switch is followed by monitoring;
check `pstatus --json` and application logs through that window. Rollback does
not undo database writes or schema changes. Use compatible migrations and
application-level idempotency when an explicit retry must write only once.
See [health checks, rollback and monitoring](PRODUCTION-OPERATIONS.md).

## Review compiler storage without deleting application data

The default shared compiler-cache retention target is 256 MiB per project.
Inspect it and preview a smaller target before deleting eligible records:

```sh
npx --no-install prnext cache --json
npx --no-install prnext cache --prune --dry-run --max-bytes 67108864 --json
```

Stop development before applying a prune. Runtime databases, page/image caches,
invalidation generations, tags and fill leases are excluded. Keep `data.sqlite3`
and recovery backups; deleting them can lose data or invalidation history.
Active workers, busy files and incomplete scans can defer reclamation. The
budget is a retention target, not a hard disk quota. Cache eviction can make
later builds slower or require downloaded fonts to be fetched again.

The Oxc React Compiler backend now needs an explicit project-local installation
of `oxc-transform-react@0.157.0` when selected. Babel remains the default;
`reactCompiler: true` does not require Oxc. Keep platform optional dependencies
enabled and read the [React Compiler guide](../packages/prnext/docs/ai/compatibility.md#react-compiler)
before changing backends. Remove a separate Fontkit dependency only if your
application itself does not import it; PRNext's internal bundle is not a public
replacement for application imports.

## Verify application behavior before switching traffic

Review production-preflight warnings, including every enabled experimental
option. Native PPR shells, streaming request bodies, parallel stylesheet
emission and Oxc compilation have separate scope limits and remain opt-in.
For streamed uploads, validate the complete input and authorization before
committing an effect; cancellation never automatically replays a mutation.

Check public pages/assets, SSR and streaming, client navigation, forms and
Server Actions, authentication, callback URLs, cache invalidation and a relocated
standalone deployment if you use one. Exercise a database outage and recovery,
a failed post-switch replacement and an explicit idempotent retry. Keep the
previous deployment available until the new one has passed your checks.

Metrics are opt-in. Configure the protected private scrape endpoint and watch
latency, errors, admission saturation, worker restarts and dropped telemetry.
The included reference tests and two-hour campaign cover controlled workloads;
they do not establish a production SLA, capacity limit or absence of memory leaks.
