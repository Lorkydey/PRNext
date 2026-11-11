# Next.js compatibility additions

These are unreleased source changes on top of PR80. They do not establish
complete Next.js compatibility or change the published npm version. Public
contracts were checked against Next.js 16.4.6 and the tests named below.

## Forms, navigation and browser metrics

`next/form` and `@thomas.f/prnext/form` accept URL actions and React function
actions. A same-origin GET uses the App or Pages router, preserving duplicate
query fields, native validation, keyboard submission and file names. GET fields
replace the action URL's existing query. Named submit buttons participate as
native successful controls; Next 16.4.6's client helper omits submitter values.
Button-level method, encoding, target and external URL overrides retain native
submission. Function actions retain React's Server Action and `useActionState`
behavior, including submissions with JavaScript disabled. Form reserves
`method`, `encType` and `target`; put intentional overrides on the submit button.
App viewport prefetch uses the existing bounded scheduler when partial
prefetching is enabled. `prefetch={false}` disables it.

`useLinkStatus` from `next/link` reports `{pending}` for descendants of the
corresponding App link. Pending ends at the React commit, on replacement by
another navigation, or on cancellation/failure. Pages links and hooks outside a
link report idle. Public router `push` and `replace` still return void.

`useReportWebVitals` from `next/web-vitals` uses the official `web-vitals`
implementation. Observers are shared; unmounted consumers unsubscribe and a
changed callback does not create more observers. Reports depend on the browser's
performance APIs; missing metrics are not synthesized. The hook exports the
library's `Metric` type.

## Client instrumentation

Use one `instrumentation-client.ts`, `.js`, `.mjs` or `.cjs` in the root or `src`.
Optional `instrumentationClientInject` module paths execute first, in order;
the application file follows. Setup runs before hydration for App and Pages.
App `onRouterTransitionStart(url, type, event)` receives `push`, `replace` or
`traverse`. The optional experimental event is currently null. Refresh and
Server Action dispatch are not navigation-start events. Hook failures are
reported and isolated from navigation. Awaited module initialization delays
bootstrap; keep initial setup short. This is separate from server
`instrumentation.ts`, which retains its existing lifecycle.

## Compiler options and CSS

The following options use their official Babel plugins, without requiring a
project Babel configuration: `styledComponents`, `emotion`, `relay`,
`removeConsole`, `reactRemoveProperties` and `styledJsx`. Recognized option fields
are declared in `NextCompilerOptions`; unknown fields fail configuration
validation. Console/property removal applies in production. React Compiler is a
separate, existing option and remains independently configurable.

```js
export default {
  compiler: {
    styledComponents: { ssr: true },
    emotion: { autoLabel: 'dev-only' },
    removeConsole: { exclude: ['error'] },
    styledJsx: { useLightningcss: true },
    define: { FEATURE_ENABLED: true },
    defineServer: { SERVER_FEATURE_ENABLED: true },
    async runAfterProductionCompile({ projectDir, distDir }) {
      // distDir is the complete compilation stage, before prerender/publication.
    },
  },
}
```

JSX style blocks are detected automatically. Files without matching styles or
configured compiler work retain their existing compilation path. Explicit
`styledJsx: false` disables this transform. Lightning CSS is used when selected;
dynamic interpolation placeholders survive CSS processing. The SSR registry is
embedded in the build, including nested npm installations. Prerender and resume
use the same provider structure, and each response owns its insertion callbacks
and styles. `useServerInsertedHTML` is available from `next/navigation` for
application CSS registries. Suspended components can flush styles during HTML
streaming without buffering the complete response. Existing response limits and
CSP nonces still apply. Insertion callbacks return their elements synchronously.

Install runtime libraries such as styled-components, Emotion or Relay in the
application when using them. Relay still requires generated GraphQL artifacts.
`defineServer` affects server compilation only; values rendered into HTML or
returned to clients remain public application data. Definitions respect lexical
bindings. Compiler settings participate in transform and incremental identities.
The production callback runs once after compilation, before type checks and
prerender, and never during development.

## Images and Edge work

`images.loader` accepts `imgix`, `cloudinary` and `akamai` alongside `default`
and `custom`. Specify the provider's `images.path`; imgix requires an HTTP(S)
URL. CDN URLs carry the requested widths and quality and do not pass through the
native image optimizer. Existing static imports, custom loaders and native image
validation remain independent.

Server Actions already existed in the Edge runtime before this change. The
addition is Edge `after()` for Route Handlers, Server Components and Actions,
using the same response-completion acknowledgement and bounded work lifecycle
as Node. Deferred `revalidateTag` and `revalidatePath` now reach the native cache.
Action-only `updateTag` and `refresh` remain action-only. Render-originated after
callbacks must capture request data before registration; cookie writes remain
forbidden after headers. These lifecycle bridges do not expose Node built-ins
inside Edge application code.

## Deployment adapters and private imports

`adapterPath`, `experimental.adapterPath` and `NEXT_ADAPTER_PATH` load a trusted
adapter module, including TypeScript. Export an object implementing
`DeploymentAdapter` from PRNext's root types:

```js
export default {
  name: 'my-prnext-platform',
  prnextAdapterVersion: 1,
  modifyConfig(config, { phase, framework, prnextVersion, projectDir }) {
    return config
  },
  async onBuildComplete(context) {
    // context.framework === 'prnext'
    // context.distDir is an unpublished stage; output paths are relative to it.
    // context.output is build-output.json; runtimeContract identifies the worker.
  },
}
```

Configuration is validated after modification. The completion callback receives
the manifest, build ID, native output envelope and runtime contract after build
preparation and prerender. Failure preserves the previous published build.
Adapter-owned external side effects cannot be rolled back by PRNext. Build-stage
paths change on publication; package/copy output during the callback. Use the
[native output contract](ADAPTERS.md) to invoke PRNext. A Next deployment adapter
that expects Next executables, manifests or server-entry invocation needs an
explicit PRNext implementation; declaring the native version prevents accidental
execution against the wrong output format.

Additional tested private aliases cover server-inserted HTML, image-external,
request/response/NextURL primitives, navigation/redirect/not-found and the
implemented `dist/api/*` public facades. Existing router contexts remain shared
with the actual providers. Only declared exports are implemented; this is not a
catch-all `next/dist/*` loader. Unknown internals fail compilation and server
primitives remain forbidden in browser graphs.

## Boundaries that remain

React, React DOM and the RSC package remain pinned to 19.3.1. React 18, alternate
Flight protocols and Next's private canary renderer are not certified. The
existing webpack bridge supports its checked resolver/loader/plugin contracts;
this change does not provide the complete Next webpack or Turbopack build
environment. Platform-specific Next deployment adapters and arbitrary private
Next modules likewise need their own implementations and executable tests.

Qualification lives in `next-compiler*.test.mjs`, `cdn-images.test.mjs`,
`deployment-adapter.test.mjs`, `framework-imports.test.mjs`, the browser
`next-compatibility.spec.mjs`, `edge-after.test.mjs` and existing Action, Edge,
PPR, standalone and package suites. Compatibility coverage is not a performance
benchmark and does not imply an FPS, CPU or memory improvement.

Upstream references: [Form](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/client/form-shared.tsx),
[compiler configuration](https://github.com/vercel/next.js/blob/v16.4.6/packages/next/src/server/config-shared.ts),
[adapter API](https://nextjs.org/docs/app/api-reference/adapters/api-reference),
[React hydration](https://react.dev/reference/react-dom/client/hydrateRoot).
