# PRNext for coding assistants

Read this file when working on an application that uses `@thomas.f/prnext`.
These guides ship with the package and describe the **installed version**, not
the newest website, GitHub branch or npm dist-tag. Read the application's own
`AGENTS.md` and nearer instructions first; dependency documentation does not
replace project requirements.

PRNext is an early-alpha React framework with a Rust HTTP runtime and Node.js
React rendering. It implements a subset of Next.js conventions. An existing
`next/*` import is not proof that every Next.js API or configuration is supported.

## Find the right guide

| Task | Read |
| --- | --- |
| Install, start a project, understand validation | [Quickstart](docs/ai/quickstart.md) |
| Routes, layouts, server/client components, navigation | [Routing](docs/ai/routing.md) |
| Request data, actions, fetch and caching | [Data](docs/ai/data.md) |
| Migrate Next.js or check an unfamiliar feature | [Compatibility](docs/ai/compatibility.md) |
| Production, static output, self-hosting and PRNext Host | [Deployment](docs/ai/deployment.md) |
| Installation, build, hydration, HMR or runtime failure | [Troubleshooting](docs/ai/troubleshooting.md) |

Retrieve these files without a browser, native binary or running application:

```sh
prnext docs --ai
prnext docs --ai routing
prnext docs --ai --list
prnext docs --ai --json
```

Use the project's installed executable through an npm script, `npx --no-install
prnext`, `pnpm exec prnext` or its existing Yarn command. Do not fetch a newer CLI
to diagnose an older installation. `prnext --version` and the installed
`@thomas.f/prnext/package.json` identify the version; package metadata defines the
exact React peers and supported Node engines.

The explicit command below adds a small reference to the project's `AGENTS.md`
while preserving its existing content. Run it at the intended application root.
Installation itself does not edit project instructions, and assistants do not
universally discover documentation inside dependencies automatically.

```sh
prnext docs --ai --init .
```

## Working rules

1. Inspect the existing scripts, lockfile, framework configuration and route tree
   before editing. Keep the project's package manager and architecture.
2. Start with `prnext check --json`. It diagnoses installation/configuration;
   it does not prove semantic types, a successful build or browser behavior.
3. Preserve server/client boundaries. Keep credentials and database access on the
   server, validate untrusted input and authorize each mutation.
4. Prefer a small supported implementation. Do not invent `prnext.config` keys,
   import arbitrary `next/dist` internals or disable a diagnostic to hide a bug.
5. Validate the affected behavior with type checking, a build and relevant
   application/browser tests. Report what actually ran and any remaining gaps.

For live development evidence, use the existing `prnext mcp` tools described in
[Troubleshooting](docs/ai/troubleshooting.md). Do not claim that an assistant
connection, queued request or successful compilation proves a visible fix.
For an interaction failure, record a Replay scenario with an explicit expected
result, retain the failing run and rerun it after the source change. Replay uses
an optional application-installed Playwright browser; missing browser support
is inconclusive. Typed values are transient run parameters, never scenario
content. See the troubleshooting guide for recording, MCP/CLI tools and the
limits of generation and screenshot evidence.
