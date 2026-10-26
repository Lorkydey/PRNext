# Build output contract v1

This contract describes the adapter and entrypoints of a completed PRNext build.
It is distinct from `runtime-contract.json`, which fingerprints the React worker
implementation and enforces lifecycle guarantees. It is not a signature or an
integrity check for arbitrary files, and build artifacts must remain trusted.

## Output selection

The project-level `.prnext-output.json` selects a relative build directory, usually
`.prnext`. Paths in `build-output.json` are relative to that directory. The runtime
does not evaluate project configuration to start a completed build.

Every new React and static build emits all seven fields below. Unknown fields,
versions, adapters, entrypoints and inconsistent build identities are rejected by
the native server before listening. Existing React builds without this metadata
retain their original runtime-contract checks. Static builds require it.

```json
{
  "version": 1,
  "adapter": "react",
  "buildId": "a-build-identifier",
  "manifest": "manifest.json",
  "assets": "assets",
  "server": {
    "entry": "runtime/worker.mjs",
    "runtimeContract": "runtime-contract.json"
  },
  "fallback": null
}
```

`buildId` must match the manifest and contain 1–128 ASCII letters, digits,
underscores or hyphens. Metadata is limited to 64 KiB. Entry paths are fixed in
v1; they cannot select an arbitrary executable or escape the build directory.
The React manifest continues to describe routing, caching and rendering details;
its implementation-specific fields are not made stable by this public envelope.

## Static adapter

Plain HTML/CSS/JavaScript sites need no package.json or React source tree:

```sh
prnext build ./my-site
prnext start ./my-site
```

An `index.html` at the project root is detected automatically. Explicitly select
it with `prnext build --adapter static --from .`. Root mode copies browser asset
extensions only; it omits dotfiles, npm metadata, JSON data, source/server folders,
configuration and server scripts. Put additional public data in a dedicated output
directory and import it with `--from`; do not put secrets in browser assets.

After running another builder, `prnext build --adapter auto` finds a completed
`dist`, `build`, `out` or `.output/public` directory. Multiple outputs require an
explicit `--from` choice. This command never runs another builder or its config.
Vite (including React, Vue, Svelte and Solid browser apps), Astro static output,
SvelteKit with `adapter-static`, and Nuxt generated output can use the same static
runtime. Keep each framework's server rendering and API routes out of the import.
See [Vite deployment](https://vite.dev/guide/static-deploy.html),
[Astro deployment](https://docs.astro.build/en/guides/deploy/),
[SvelteKit static generation](https://svelte.dev/docs/kit/adapter-static), and
[Nuxt deployment](https://nuxt.com/docs/4.x/getting-started/deployment).


Build the application with its own tool, then import **only** its public browser
output. Vite's default output is `dist`; see its [deployment guide](https://vite.dev/guide/static-deploy.html).

```sh
npm run build
prnext build --adapter static --from dist
prnext output --json
prnext start --hostname 127.0.0.1 --port 3000
```

Programmatic equivalent:

```js
import { build, buildStatic, readBuildOutput } from '@thomas.f/prnext';
await build(projectRoot, { adapter: 'static', from: 'dist', spa: true });
// Or: await buildStatic(projectRoot, { from: 'dist', spa: true });
const output = await readBuildOutput(buildDirectory);
```

The static envelope has `adapter: "static"`, `assets: "static"`, `server: null`
and `fallback: null`. With `--spa`, fallback is `"index.html"`. Its manifest has:

```json
{
  "version": 1,
  "buildId": "a-build-identifier",
  "config": { "staticOnly": true, "staticFallback": false, "compress": true, "poweredByHeader": true },
  "routes": [],
  "prerendered": [
    { "path": "/", "file": "static/index.html", "revalidate": false }
  ]
}
```

Every imported file has an exact, URL-encoded path in `prerendered`; `file` stays
relative to the build. `/index.html` also maps to `/`, `/docs/index.html` to `/docs`,
and `/about.html` to `/about`. Conflicting aliases fail the import. Normal native
trailing-slash redirects apply. No server routes, middleware, ISR or cache handler
can be declared. The project's separate `public/` directory is not served.

With SPA fallback enabled, unmatched GET/HEAD requests that explicitly accept
`text/html` can receive the root index. Existing files and pages take precedence.
Missing file extensions, `/api/*`, hidden paths and framework transport paths do
not fall back. JSON requests and POSTs never receive an SPA fallback. Apps using
dotted client route names need explicit HTML output for those URLs. Configure the
source builder's asset base for its deployed URL; the adapter does not rewrite JS
or HTML assets or infer subpath hosting configuration.

Dedicated public source directories must be inside the project, separate from the destination,
with real directories and files. Symlinks, dotfiles other than a root `.well-known`
tree, `node_modules`, reserved `_next`/`_prnext` paths and a root `server` directory
are rejected. Limits are 20,000 files, 512 MiB total and 64 directory levels.
Environment files and server outputs must never be placed in public input.

Imports use a staging directory and publish the manifest, files and output pointer
together. A validation/copy failure leaves the previous build intact. Source files
and configuration are untouched. A project lock excludes concurrent React builds
and static imports, including separate processes and canonical path aliases.
Another active build fails clearly; a dead local owner is recovered. A lock from
another host, an unverifiable owner or an interrupted lock recovery fails closed;
check `.prnext-build.lock` manually only after confirming no build is active.
Finish the source framework build before importing its files.

Compressible files are precompressed with the same bounded gzip pipeline as React
builds. Source files are unchanged. Existing gzip sidecars must decode exactly to
their source; a mismatched sidecar fails the import and preserves the last build.

Serve with the updated native binary from this source candidate. Node can run the
CLI to build/start, but no Node worker or React installation is required to serve
static requests. `prnext host` can validate and host these completed artifacts.
Cloud source-build auto-detection is a separate integration; this change does not
change existing PRNext Host projects or enable generic SSR hosting.

## Extending adapters

The output adapter names are `react` and `static`. Build selection also accepts `auto`, which inspects completed output and never starts a third-party builder. Unknown adapters fail rather
than being silently interpreted as React. Add a new adapter only with a documented
runtime model and integration tests. A future generic Node SSR adapter needs its
own request/response, streaming, cancellation, crash and shutdown contract; a
`server` path alone does not implement those guarantees.
