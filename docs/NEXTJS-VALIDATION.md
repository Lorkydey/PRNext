# Next.js migration validation

PRNext compares production builds, HTTP responses and browser behavior with the pinned Next.js 16.4.6 and React 19.3.1 reference. The [CI job](../.github/workflows/ci-platform.yml) runs the reference suite on Ubuntu with Chromium. Next.js builds use its Webpack path.

| Scope | Behavior exercised against Next.js |
| --- | --- |
| App and Pages routing | Mixed App and Pages applications, static and dynamic routes, redirects, rewrites, static files, Pages API routes, locales and domain routing, and `next/compat/router` in both routers |
| App navigation | Per-link prefetch policy, client navigation, query and route parameters, mounted metadata and request context, Server Action form submission and redirects |
| Request and response primitives | Cookie parsing and mutation, cookie attributes, cloned URLs, localized data URLs, response redirects and rewrites, and proxy request-header overrides |
| Ecosystem | Better Auth sessions and forms with SQLite and Drizzle, next-intl server messages, MDX with a Webpack loader, and `after()` in a Server Component |
| Boutique migration | CLI preview and apply, configured redirect, App Router product page, Server Action validation and success, and an HttpOnly customer cookie |
| Documentation migration | CLI preview and apply, Pages Router cache reuse and on-demand ISR via `res.revalidate()` |
| Portal migration | CLI preview and apply, unauthenticated proxy redirect, authenticated request headers, two isolated cookie jars, and personalized streamed HTML |

The migration cases copy the [sample applications](../examples/next-migration), run the preview and apply commands, verify the package backup and launch both frameworks. The test supplies the pinned dependencies and links the candidate framework checkout. Run `prnext migrate --check` and the application’s own production tests when evaluating additional features or configurations. The [compatibility guide](../packages/prnext/docs/ai/compatibility.md) describes scope and known gaps, including the Edge runtime.

## Reproduce the comparison

```sh
npm ci
npm run build:native
npm ci --prefix tests/ecosystem --workspaces=false --ignore-scripts --no-audit --no-fund
npx playwright install chromium
PRNEXT_NEXT_REFERENCE="$PWD/tests/ecosystem/node_modules/next" npm run test:next-compat
```

## Rehearse a production rollout

The [SaaS endurance workflow](../.github/workflows/saas-endurance.yml) offers a `rollout` mode. It installs packed PRNext and native artifacts in an independent copy of the SaaS reference app. A supervisor switches from build A to build B while two accounts use real PostgreSQL sessions and read a shared public Redis entry. An injected health failure in B triggers automatic restoration of the original running build A.

The rehearsal checks account isolation, successful browser Server Actions before and after the switch, and one committed row per retry key across both generations. The report includes per-phase p95 and p99 request latency, rollback time and sampled process-tree memory. The longer `full` mode adds Redis crash testing and a two-hour endurance run.

```sh
npm ci --prefix tests/toolchain --workspaces=false --ignore-scripts --no-audit --no-fund
node tests/reference/rollout.mjs --run --hold-seconds 60 --output-directory artifacts/saas-rollout
```

The local rehearsal requires PostgreSQL executables and Redis. Set `PRNEXT_POSTGRES_BIN` to the PostgreSQL binary directory or `PRNEXT_REDIS_SERVER` to a Redis executable where discovery requires it. On Windows, the [portable Redis setup](../scripts/portable-redis.mjs) can prepare the test executable.
