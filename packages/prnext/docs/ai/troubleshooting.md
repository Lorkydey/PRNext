# Troubleshooting and live verification

[AI documentation index](../../AI.md)

## Collect a useful failure

Read the installed version, command, working directory, Node version, manager,
configuration and first complete diagnostic. Separate build errors, semantic
TypeScript errors, server exceptions, HTTP failures and browser hydration
errors; they have different causes. Keep secrets, cookies and authorization
headers out of reports.

```sh
prnext --version
prnext check --json
prnext typecheck --json
```

`check` does not install, compile or start the application. `typecheck` generates
types and runs application-installed TypeScript; it needs the application's
tsconfig and may update generated references. `build` then exercises loaders,
server/client transforms and prerendering. A browser visit checks the live
result. Report which layer failed instead of treating one green command as proof
of all layers.

## Common diagnoses

| Symptom | Check first |
| --- | --- |
| Native component missing or wrong version | Optional dependencies, supported platform/Node, package lock, framework/native version family and an unintended `PRNEXT_BINARY` override. |
| Peer or React server/client mismatch | Exact installed React, React DOM and RSC peers; duplicate React instances and a second framework runtime. |
| Unknown configuration option | The installed version's accepted config; remove or replace only after understanding the intended feature. |
| Cannot resolve a framework import | Public supported subpath, dependency placement and the migration audit; do not fabricate a private adapter. |
| Hook or server-only import error | The nearest `'use client'` boundary and everything it imports; keep Node/secret code on the server. |
| Request API outside context | Move cookie/header access into a request; cached callbacks receive needed values as arguments. |
| Type errors missing from editor or build | Run `prnext typecheck`; inspect `typescript.tsconfigPath`, inherited roots and existing aliases. |
| A prerender needs runtime data | Decide whether the route is actually dynamic; do not insert build-time production credentials or suppress the bailout blindly. |
| Cached content remains stale | The affected cache layer, explicit key/tags and mutation-phase invalidation; custom handlers may delegate caching. |

Do not manually patch installed native binaries or force a different release
into an application. Reinstall through the existing manager and reviewed
lockfile if installation is the actual problem. Keep the original diagnostic
when reporting a platform that lacks a compatible published component.

## Hydration errors

Compare server HTML with the first client render. Typical causes include
`Date.now()`, random values, locale/time-zone differences, invalid HTML nesting,
browser-only conditions and client state initialized from storage. Pass stable
server values as props or move browser reads to a lifecycle. Check that the
browser loaded assets from the matching build. Use `suppressHydrationWarning`
only for a deliberately unavoidable, understood mismatch; it is not a general
repair. Verify the interactive result after the change.

## HMR and cache failures

Development compiles requested routes and preserves state for compatible edits;
config/environment, custom Document or incompatible module changes can reload
the document. Production prerendering and compression are not development HMR.
An unused route need not rebuild until requested.

For a controlled diagnosis, stop only the development process you own and try:

```sh
prnext dev --safe
```

Safe mode uses full builds and fresh workers. `PRNEXT_BUILD_CACHE=0` disables
PRNext's compiler/build caches when set in the current process environment; use
the syntax appropriate to the user's shell and restore the previous setting
after the comparison. Optional cache-storage failures should fall back to work,
while genuine loader errors remain build failures. Do not delete every cache or
lockfile as a first response, especially with another server running.

For production observations:

```sh
prnext start --inspect
prnext inspect --json
```

The inspector needs actual traffic for observed timings. Header-ready timings
exclude the full streaming body, and missing/dropped samples are not zero.
`prnext routes` describes compiled routes. Bundle size questions use
`prnext analyze`, after building, rather than interpreting request time as
compiler performance.

## Connect the existing development MCP

Start `prnext dev` in the application, then configure a compatible assistant to
launch the following **stdio MCP command** with its absolute project directory:

```sh
prnext mcp /absolute/path/to/application
```

Use the locally installed executable, not an unreviewed remote package. This
stdio process is a tool server for an MCP client, not a second application
server. The development endpoint binds to loopback; its private
`.prnext-dev/tools.json` contains a capability, so never publish or paste that
file. No new shell-access tool or public debug endpoint is needed.

The existing tools include `dev_snapshot`, `dev_logs`, `dev_routes`,
`dev_route_ensure`, `dev_cache_invalidate`, `dev_source`, `dev_ai_context` and
`dev_verify`. Replay adds `dev_replay_list`, `dev_replay_save`,
`dev_replay_run`, `dev_replay_result`, `dev_replay_export` and
`dev_replay_delete`. Read their returned schemas rather than inventing tool
arguments.

For a fix, capture `dev_snapshot` before editing and retain its `sequence`.
After the edit, call `dev_verify` with that value as `sinceSequence` and the
pathname being checked. Keep an actual application browser open. Verification
requires a newer successful generation and browser evidence that it applied
that exact build. A missing build or browser is inconclusive; compilation,
TypeScript or reported browser errors fail the observation. Continue relevant
application tests: this development observation does not establish complete
functional correctness.

## Record and replay a functional failure

Use **Replay** in the development tools to record the affected route and its
clicks or form interactions. Stop recording, add an explicit visible-element,
text or URL assertion, name the scenario and save it. Recording alone does not
describe the intended result: a click handler that silently does nothing can
have no console errors and still be broken. Manual recording and replay work
without an assistant connection, model key or hosted service.

The browser adapter is optional. Install it in the application only when replay
is wanted, using the application's existing package manager. With npm:

```sh
npm i -D @playwright/test
npx playwright install chromium
```

The base PRNext installation is unchanged. Replay resolves the browser adapter
from the application, does not use a framework-owned copy and never installs or
downloads one automatically. A missing adapter or browser produces an
**inconclusive** result with setup guidance; it must not be reported as a pass.

Scenarios contain only versioned steps, a viewport, relative application paths
and element targets. Prefer roles with accessible names, labels or test IDs.
Fill steps refer to named run parameters instead of saving typed values.
Password and credential fields are excluded from recording. Supply private
values for the current run only; keep them out of scenario names,
assertion text, selectors and shared reports. Routes stay on the local
application origin; external URLs and malformed scenarios are rejected.

Replay accepts at most 50 steps per scenario and 50 saved scenarios, with a
128 KiB total limit for saved definitions. Definitions live in
`.prnext-replays/scenarios/`. Local results and screenshots
live in `.prnext-replays/results/`; keep generated evidence out of version
control. Review a definition before committing it, because labels, pathnames
and expected text may still contain application information. Screenshot capture
masks editable fields; review the rest of the page before sharing evidence.

For an assistant-led fix:

1. Read the queued request and inspect the recorded scenario. If there is no
   useful assertion, ask for the expected behavior or add one with the user.
2. Run the scenario and retain the failing result. Use the assistant's own
   editor and normal development tools to make a scoped source change.
3. Call `dev_replay_run` with the saved scenario's `id` and any transient
   `parameters`. It returns a `runId` immediately. Poll `dev_replay_result`
   with `id` and `runId` while its state is `running`.
4. Compare the previous failure with the new result, failed step, browser
   errors, screenshots before and after that replay and build identity. A
   previous run is separate evidence; compare runs only when their
   `scenarioHash` matches. Claim a verified fix
   only when the assertions pass and the browser confirms the exact successful
   development generation. A successful unrelated edit does not satisfy a
   failing assertion. Stale, missing or changing build evidence is
   inconclusive.

PRNext supplies context and executes requested tools. Connecting an assistant
or queuing a request does not edit source, invoke a model or run a replay by
itself. Replay can activate real application controls and mutations, so run it
only against the development data and actions intended for that scenario.

The same local tools are available through the installed CLI while `prnext dev`
is running:

```sh
prnext replay . --list --json
prnext replay . --run <scenario-id> --json
prnext replay . --result <scenario-id> --run-id <run-id> --json
prnext replay . --export <scenario-id>
```

`--run` waits for a bounded result; `--result` reads the current result once.
Use `--parameters /path/to/private-values.json` for transient named fill
parameters, and keep that file private. `--export` prints an ordinary Playwright
test for application review and adoption. Set `PRNEXT_REPLAY_BASE_URL` to the
intended loopback application URL and `PRNEXT_REPLAY_<parameter>` for each named
fill parameter when running that test. Export does not install dependencies,
change assistant configuration or run the exported test. Relevant application
tests and build/type checks still apply beyond the recorded path.

Local MCP works independently of managed hosting. `prnext dev --host-ai` is an
explicit relay option for a logged-in terminal and a compatible connected Host
server; it can share requested diagnostics and queued context. Do not enable
remote sharing or change a user's assistant configuration as a hidden side
effect of fixing an application.
