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

Use `prnext start --inspect` and `prnext inspect --json` for sampled route/cache
and runtime observations. `prnext analyze --json` describes built browser
JavaScript; it is not an SSR latency measurement. A production profile can be
selected with `--profile balanced|speed|memory|classic`; benchmark the real
workload before changing defaults. A benchmark from another machine or profile
is not evidence for this application.
