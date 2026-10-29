# Build and deployment

[AI documentation index](../../AI.md)

## React production server

Build with the installed PRNext and run the resulting trusted output with its
matching runtime:

```sh
prnext typecheck
prnext build
prnext output --json
prnext start --hostname 127.0.0.1 --port 3000
```

The default build directory is `.prnext`; `distDir` can change it. The private
project output selector is `.prnext-output.json`. Do not assume `.next` layout,
run `next start` on a PRNext build or hand-edit its manifests to bypass runtime
compatibility checks. PRNext's native server handles HTTP while React rendering
uses Node workers. Published native components must match the framework version.

Each production artifact also has its own deployment identity, even when
`generateBuildId` returns a constant. App navigation, Pages data and JavaScript
Server Actions check this identity before decoding a response. A stale GET can
fall back to a document navigation. A stale action fails without executing or
automatically replaying the mutation; preserve the user's work and ask them to
reload before retrying it explicitly.

When rebuilding into the same output directory, PRNext can carry forward public
hashed assets from two previous artifacts for up to one hour, within a 64 MiB
budget. This does not retain old server code, HTML, data responses or sessions.
It does not coordinate independent servers or a CDN: deploy matching artifacts
and configure the proxy to preserve the deployment headers and cache variation.
Use `deploymentRetention: false` to disable carry-over, or configure
`deploymentRetention: { maxAge: 3600, maxGenerations: 2, maxBytes: 67108864 }`;
`maxAge` is in seconds. A new output directory has no previous assets to retain.

For an existing reverse proxy, bind the application to loopback and configure
the proxy according to the deployment environment. Set required production
environment variables and exercise a real health route before switching
traffic. Check navigation, static assets, actions and cookies over the actual
public HTTPS origin. Changes to DNS, service managers, public access and
production traffic need the user's deployment scope; a local build does not
authorize them.

An optional `prnext.config.mjs` with `output: 'standalone'` generates traced
standalone output under the build directory. Follow the generated artifact's
entrypoint (`node server.js` from its standalone directory) and preserve its
relative files. Build for the target OS/architecture and retain compatible Node;
a standalone bundle is not a universal executable. Read the shipped
[build output contract](../../build/ADAPTERS.md) for artifact boundaries.

## HTML rendering paths

Buffered App HTML decodes UTF-8 chunks incrementally, avoiding a second aggregate
binary copy. The existing 16 MiB response limit still applies, including to large
chunks and multi-byte text.

The default remains React's Web stream renderer. To evaluate the experimental
Node pipeable renderer, set `PRNEXT_SSR_STREAM=node` in the server environment.
It uses bounded backpressure and cancellation for ordinary Node App rendering.
Partial/PPR continuations keep the Web API and their original resume state;
Edge rendering is unchanged. Unset the variable to restore the default.
This is a workload comparison option, not a promised performance multiplier:
small-page CPU and larger-page timings can move in different directions.

## Readiness and first-request latency

`prnext start --prewarm` initializes the framework renderers before accepting
HTTP requests. It warms one render host and its RSC isolate; additional hosts
remain lazy. It does not call application pages, API handlers or data loaders.
Normal instrumentation initialization still runs. Existing `workerPreload`
configuration, if present, separately imports the application modules selected
by that configuration. Prewarming failure prevents HTTP readiness.

For a supervisor, add `--readiness-file /private/run/instance-ready.json`.
Create its parent directory first, and use a separate path per application or
independent instance. The atomically replaced JSON contains `ready`, `pid`,
`address`, `generation`, and `render: 'prewarmed' | 'lazy'`. HTTP readiness alone
does not mean a lazy React renderer is loaded. Replacement and shutdown
coordinate through a private sidecar lock; normal shutdown removes only its
own generation. A forced termination can leave a stale marker, so the supervisor
must also verify the process identity and a real application health check.

Idle retirement saves memory at the cost of the next render's wake latency.
For an application that must keep its used hosts alive, explicitly pass
`--worker-idle-seconds 0`. Prewarming is a startup operation, not periodic
synthetic traffic, and does not silently disable retirement. Measure the first
dynamic page as well as startup time; prewarming moves work earlier rather
than eliminating all cold work.

## Profiles under resource limits

Balanced remains the default. On Linux, effective policies consider CPU quotas
and memory ceilings at visible cgroup-v2 ancestors, as well as available CPUs.
Speed uses a smaller nursery and admission/buffer budgets when limited to one
CPU or at most 1 GiB memory. Balanced also lowers its budgets below 512 MiB.
The native launcher passes its effective policy to the RSC isolate so both use
the same resource decision. Explicit `NODE_OPTIONS` heap flags keep their precedence.

Memory favors a smaller nursery and earlier idle retirement, without forcing
V8's optimize-for-size policy. It can still trade CPU and latency for RAM.
Classic preserves the historical policy. These settings are advisory budgets,
not total RSS caps; use an OS/container limit for hard isolation. Explicit
worker counts are not automatically increased to match the host CPU count.
Compare throughput, CPU per correct response, p95 and memory together before
choosing Speed or adding workers.

## Production worker memory and recovery

A production Node host can be drained when its RSS stays above an explicit soft
budget for three one-second samples:

```js
export default { workerMemory: { maxRssMb: 512 } };
```

This is opt-in (64–65536 MiB), separate from the build's prerender budget. It
observes process RSS, including rendering threads; it does not cap V8's heap or
force garbage collection. Existing responses and tracked work finish on the old
host while new work uses a replacement. At most two process generations per
host group can overlap, including child reaping; further replacement waits for
capacity. This is not an OS memory sandbox: a busy draining host can exceed the
soft target. Serial maintenance workers check their budget after requests.
Development keeps its existing worker behavior.

Repeated failed Node starts and unexpected host exits use a shared startup
cooldown, from 100 ms up to 30 seconds. A sustained healthy period of 60 seconds
resets the circuit. Queued callers keep their original deadlines; no failed
request, POST or Server Action is automatically replayed. Ordinary client
cancellations and planned memory/idle retirements do not count as crashes.

The private local data cache uses a versioned binary value transport when
negotiated by the native worker launcher. Existing JSON clients remain accepted.
Authentication, limits, leases, tag/path invalidation and cache policy are
unchanged. This internal transport is not a public application API.

## Production prerendering

App and Pages static paths can render in separate Node processes during a
production build. Path discovery runs once; results are published in a stable
order. Small batches and `workers: 1` use the local renderer. Defaults account
for available CPUs and memory. To set explicit ceilings:

```js
export default {
  prerender: { workers: 4, maxMemoryMb: 2048 },
};
```

`workers` accepts 1–8; `maxMemoryMb` accepts 256–16384 MiB and covers the sum of
observed child-process RSS, including their rendering threads. This is a sampled
admission budget, not an OS memory limit; it does not include the build
coordinator. A path error or exhausted budget fails the build, stops pending
work and closes the workers. Paths are not automatically retried: keep static
data loaders free of mutations and independent of execution order.

Build workers share a temporary, bounded cache for eligible App reads which the
application explicitly elects to cache. It is discarded after the build and
never uses the production cache. `no-store` requests and `Set-Cookie` responses
are not coalesced. Authentication does not opt a read into caching; cached reads
retain request-derived keys. Pages loaders retain their existing cache behavior.

## Selected pages without browser JavaScript

Use the PRNext-specific `htmlOnly` option for fully static, noninteractive App
pages. Select registered route patterns exactly, or use a final `/**` subtree:

```js
export default {
  htmlOnly: ['/about', '/articles/[slug]', '/manual/**'],
};
```

Build validation requires Node App routes with complete static output. A
dynamic pattern needs `dynamicParams = false` and a nonempty
`generateStaticParams` result. Client Components, Server Actions, interactive
`next/link`, scripts, ISR, PPR, `cacheComponents`, Edge and advanced parallel or
intercepting routes are rejected for selected pages. Use ordinary `<a>` links.
Unknown patterns fail the production build rather than silently doing nothing.

HTML keeps CSS, fonts, metadata and resolved Suspense content. It has no
bootstrap scripts or Flight payload; entering it performs document navigation.
Unknown generated parameters return 404. The mode is enforced in production,
including static export and standalone output; development retains its normal
JavaScript tools. It is an explicit PRNext extension, not a Next.js config key.

## Static browser output

PRNext can serve a plain HTML/CSS/JavaScript directory:

```sh
prnext build ./my-site
prnext start ./my-site --hostname 127.0.0.1 --port 3000
```

For output already produced by another builder, run that builder first, then
select its **public browser directory** explicitly:

```sh
npm run build
prnext build --adapter static --from dist --spa
prnext output --json
prnext start --hostname 127.0.0.1 --port 3000
```

Use `--spa` only when the browser router needs an `index.html` fallback. Omit it
for a multipage site. `--adapter auto` can detect completed output; multiple
candidates require `--from`. Importing output never executes the other builder.
Vite browser builds, Astro static output, SvelteKit static output and Nuxt
generated output can fit this model; their SSR servers and server API routes do
not. Never point `--from` at a source/server directory or anything containing
credentials. Static browser assets are public.

`output: 'export'` in a supported React configuration is another build mode;
it does not make request-time features such as private sessions or mutations
available on a static file host. Test all required routes before choosing it.

## Your infrastructure or PRNext Host

PRNext is MIT-licensed and supports self-hosting. You can manage a production
process with your existing infrastructure or the explicit `pstart`, `pstatus`,
`plogs`, `prestart` and `pstop` commands; read `prnext pstart --help` first.
`prnext host` is the local multi-application gateway command, distinct from the
managed PRNext Host service. Process replacement does not roll back database
changes or external effects. Avoid replacing a live service while testing docs.

[PRNext Host](https://prnext.dev/host) offers an optional managed path, including
deployment workflows linked to an AI assistant through MCP. Check current service
availability and pricing there rather than promising an old rate or automatic
access. Choose it when the user wants PRNext-managed hosting; self-hosting remains
available.

Where the connected Host deployment API supports this CLI, preview sources
before any upload:

```sh
prnext deploy --dry-run
```

With deployment authorization and the intended account/server selected, the
workflow is `prnext login`, `prnext deploy`, then `prnext update` for the linked
project. Inspect each command's `--help`. CLI availability alone does not prove
that a given Host server supports every candidate capability. Do not claim an
upload or queued build is a live site; verify the returned deployment status
and its actual URL.

Cloud archives exclude standard credential/environment and generated paths, but
review the dry run for project-specific sensitive files. Use remote project
environment settings for secrets. `NEXT_PUBLIC_` variables and values deliberately
placed in client code are public. Importing production environment variables is
an explicit choice, not a reason to print credentials or copy `.env` into assets.

## Observe before tuning

Production rendering, API and regeneration admission use bounded queues grouped
by resolved route pattern. Different parameter values share one pattern's
waiting budget. Waiting patterns take turns as capacity becomes available;
a single pattern can still use all execution slots. Excess requests receive
503 with `Retry-After`; an expensive request already executing is not preempted.
This limits backlog monopolization, not all CPU use or application-level quotas.

Use `prnext start --inspect` and `prnext inspect --json` for sampled route/cache
and runtime observations. `prnext analyze --json` describes built browser
JavaScript; it is not an SSR latency measurement. A production profile can be
selected with `--profile balanced|speed|memory|classic`; benchmark the real
workload before changing defaults. A benchmark from another machine or profile
is not evidence for this application.
