# Health checks, rollback and monitoring

Build with the PRNext version that will run the application. Bind the application
to loopback behind your HTTPS proxy, then verify the public URL, authentication,
static assets and mutations before switching production traffic.
PRNext remains an alpha; these checks do not establish a production SLA.

## Configure the public origin

Set the canonical external origin in `prnext.config.mjs`:

```js
export default {
  server: {
    publicOrigin: 'https://example.com',
    trustedProxies: ['127.0.0.1', '::1'],
  },
};
```

The canonical origin takes precedence when constructing request URLs and
redirects. Trust only the addresses or CIDR networks of proxies that connect
directly to PRNext. The list accepts at most 32 entries. Forwarded protocol and
host headers are used only for an allowed TCP peer; incoming headers do not
make a client trusted. This policy does not establish a trusted client-IP chain
or implement the RFC `Forwarded` header.

For Caddy on the same host, replace the domain and keep PRNext on loopback:

```caddyfile
example.com {
  @metrics path /_prnext/metrics
  respond @metrics 404
  reverse_proxy 127.0.0.1:3000
}
```

Caddy sets the forwarded host and protocol for its upstream. Its automatic
HTTPS requires working DNS and access to the appropriate public ports. Scrape
metrics directly through the private network rather than this public route.
If you use a `basePath`, also block its mounted metrics alias at the proxy.
See [Caddy's reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

For nginx, add these locations to the TLS server block for the public domain:

```nginx
location = /_prnext/metrics { return 404; }

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
}
```

Configure TLS certificates and HTTP-to-HTTPS redirection in nginx separately.
Disabling buffering allows streamed responses to reach the client promptly;
set upstream timeouts to match your application's streaming requirements. These
minimal recipes do not configure WebSocket upgrades or a CDN in front of the
proxy. Test those paths separately if you use them. See
[nginx's proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

## Isolate account state during navigation

Set `navigationCache.authCookies` to the names of the cookies that identify the
signed-in account. PRNext then waits for the fresh Flight model's session
identity before revealing a cached PPR preview. Prefetch still prepares shell
data and modules, but the static preview is deferred. A fresh model with the
same known account identity preserves its draft and shared layout state. A
changed or unknown identity requires a fresh document before adopting any
layout or page state. This also resets shared client layouts and cached server
layout props. Wholly static models have no live identity, so strict navigation
to them uses a document request even for the same account. Restoring a strict
document from browser back/forward cache likewise requires a fresh document;
the old document stays hidden during that check.
Private pages that need draft retention should observe the authenticated
session or `await cookies()` on the server so their live models carry an
identity. Authorize protected reads and mutations with your session checks.
An action that changes the account executes once and retains its result, then
reauthorizes through a GET document request. Further actions are rejected until
replacement; PRNext never replays the mutation automatically.
If a loading shell from another account is interrupted, PRNext reauthorizes
through a document request instead of restoring the previous private model.
An action attempted in that incomplete state is rejected before dispatch; the
user must repeat it explicitly after the new document loads. No mutation is
automatically replayed.

## Check readiness

`GET /_prnext/health` is a reserved native endpoint. A ready instance returns
HTTP 200 with `Content-Type: application/json`, `Cache-Control: no-store` and:

```json
{"schemaVersion":1,"status":"ready"}
```

The endpoint bypasses application routes and middleware. It contains no account
or configuration data. Readiness becomes unavailable when graceful shutdown
starts. `HEAD` returns the same status without a response body.

This check confirms the native server can accept traffic. Lazy Node workers,
your database and external services need an application health route. Keep that
route anonymous, read-only and cheap. Return HTTP 200 only when the dependencies
needed to serve traffic are available; use HTTP 503 otherwise. Include no
credentials, connection strings or user data in its response.

For a persistent application:

```sh
prnext pstart . --name web --port 3000 --health-path /api/health
prnext prestart web
prnext pstatus web --json
```

The manager first checks the native endpoint, then the optional application
route. Both must finish within `--health-timeout` (15 seconds by default).
Native responses are limited to 4 KiB; application responses to 64 KiB. Both
require a complete HTTP 200 response. Redirects, oversized or truncated bodies,
timeouts and an invalid native readiness protocol fail the check. The manager
does not follow redirects or infer health from a login page.

Previously saved applications keep their configured health path, including `/`.
For an application that redirects its homepage, stop and recreate its persistent
settings with a dedicated `--health-path`.

## Monitor a replacement after switching traffic

`prestart` checks the replacement before switching traffic and retains the
previous instance during `--rollback-window` (15 seconds by default; maximum
120 seconds). Three consecutive health failures or an unexpected replacement
exit trigger rollback. The previous instance must still pass its own health
checks before it receives traffic again.

Existing responses drain on the retired instance within `--drain-timeout`.
PRNext does not replay failed requests, POSTs or Server Actions. A response can
be lost after an application write succeeds. Use an application idempotency key
and a database transaction when an explicit retry must not create a second
write. Rolling back server code does not undo database changes; deploy compatible
schema migrations.

`pstatus --json` reports the active process, build, retained rollback window and
the reason for a rollback. Check these fields and application logs after a
replacement. A successful `prestart` confirms the initial switch, not completion
of the monitoring window. Setting `--rollback-window 0` disables that window.

## Scrape native metrics

Set `PRNEXT_METRICS_TOKEN` to a private random value of 32–256 visible ASCII characters
in the application environment. Without this setting, the metrics endpoint is
disabled. Scrape `/_prnext/metrics` with an `Authorization: Bearer <token>` header
from your monitoring service. Keep the token in your monitoring service's secret
store, avoid query-string credentials and restrict access at the reverse proxy.

The native metrics include `http_server_request_duration_seconds`,
`http_server_active_requests`, response outcomes, admission saturation and
worker lifecycle counters. Request
duration follows the response body through completion or cancellation. Fixed
labels keep cardinality bounded; URLs, queries, cookies and account identifiers
are not metric labels. The HTTP histogram labels are `http_request_method` and
`http_response_status_code`. `GET` and `HEAD` accept the same authentication;
request `Accept: application/json` for a structured local snapshot.

Start with alerts for sustained server errors, rising duration percentiles,
admission rejections/timeouts and repeated unexpected worker restarts. Track
client cancellations separately from application failures. Choose thresholds
from the service's baseline and latency requirements.

## Detect telemetry loss

OTLP/HTTP JSON export remains opt-in through `OTEL_EXPORTER_OTLP_ENDPOINT` or
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, with protocol `http/json`. Set
`OTEL_SERVICE_NAME` to identify the service. Collector failures do not change
application responses.

Native and Node exporters keep bounded queues and cumulative counters for
queued, dropped and exported spans, export attempts/failures and failed batches.
Collector partial success counts accepted spans separately from `rejectedSpans`;
rejected spans are also included in dropped spans and are never replayed. A
malformed or oversized successful acknowledgement is counted as an unconfirmed
batch and is not retried. Collector response bodies are limited to 16 KiB and
their messages are not logged.
A permanent HTTP rejection such as 400 is counted and is not retried. Temporary
failures retry at most three times. When a queue fills, new spans are dropped
and counted rather than retaining unbounded memory.

Native exporter counters remain visible in local metrics even when the
collector is unavailable. Node emits diagnostic events on the
`prnext.telemetry` channel. Subscribe from Node instrumentation to forward these
fixed counters to your existing local metrics or logs:

```js
import {subscribe} from 'node:diagnostics_channel';

export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  subscribe('prnext.telemetry', ({reason, droppedSpans, failedBatches}) => {
    // Record these cumulative values in your monitoring system.
    // Do not send this notification through the failing trace exporter.
  });
}
```

Failure warnings are rate-limited to one per ten seconds per exporter process.
They contain counters and a fixed reason, without collector URLs, credentials,
request contents or transport exception messages. Counters reset when a process
restarts. Alert on increases in dropped spans and failed batches, and check the
collector and its authentication before increasing queue or memory limits.
