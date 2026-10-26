# Quickstart

[AI documentation index](../../AI.md)

## Identify the installation

Read `package.json`, the lockfile and the nearest project instructions. Use the
installed version of this documentation. Keep an existing npm, pnpm or Yarn
workspace instead of introducing a second manager or another lockfile.

This package requires the exact peer family **React 19.3.1, React DOM 19.3.1 and
react-server-dom-webpack 19.3.1**. Its Node engine range is
`^22.23.4 || ^24.22.1 || >=26.12.1`. Check the installed package manifest when
upgrading; these requirements may change between releases.

Published releases include a matching native component through optional
dependencies for Windows, macOS and glibc Linux, on x64 and ARM64. Keep optional
dependencies enabled. Consumers do not need Rust; building PRNext from its source
repository is a different workflow. Do not install a platform package separately
or combine package versions to work around an installation failure.

## Minimal App Router application

For a new application, start with the manifest below, then install dependencies.
For an existing application, merge only the necessary scripts and preserve its
other fields. Follow [Compatibility](compatibility.md) for a Next.js migration.

### `package.json`

```json
{
  "name": "my-prnext-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "prnext dev",
    "build": "prnext build",
    "start": "prnext start",
    "check": "prnext check",
    "typecheck": "prnext typecheck"
  }
}
```

Install with the existing manager; for npm:

```sh
npm i --save-exact @thomas.f/prnext react@19.3.1 react-dom@19.3.1 react-server-dom-webpack@19.3.1
npm i -D typescript @types/react@19 @types/react-dom@19 @types/node
```

`--save-exact` pins the resolved framework and React family in the manifest;
commit the resulting lockfile as well. An unqualified PRNext install follows
npm's `latest` tag. Use
`@alpha` or a specific published version only when that is the intended release;
do not assume a local source candidate exists on npm. If it installs another
release, read that release's bundled documentation and peer requirements.

Create the following TypeScript configuration only if the project has none.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts", "**/*.tsx"]
}
```

### `app/layout.tsx`

```tsx
import type { ReactNode } from 'react';

export const metadata = {
  title: 'My PRNext app',
  description: 'A React application served with PRNext.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
```

### `app/page.tsx`

```tsx
export default function Home() {
  return <main><h1>Hello from PRNext</h1></main>;
}
```

Start development:

```sh
npx --no-install prnext check --json
npm run dev
```

Use the URL printed by the server. Do not assume port 3000 is free or stop
unrelated servers to obtain it. An explicit development port is supported:
`npm run dev -- --port 3001`.

No configuration file is required to build the two components. When needed, keep one
`prnext.config.js|mjs|cjs|ts` or `next.config.js|mjs|cjs|ts`; multiple configuration
files are rejected. For a new application using generated route declarations,
`prnext.config.mjs` can contain:

### `prnext.config.mjs`

```js
export default { typedRoutes: true };
```

## Validate each layer

```sh
npx --no-install prnext check --json
npx --no-install prnext typegen --json
npm run typecheck
npm run build
npm run start -- --hostname 127.0.0.1 --port 3001
```

`check` diagnoses configuration, routes, Node, native components and dependencies
without compiling or installing. Project configuration is evaluated: run it only
for trusted source. `typegen` and `typecheck` require TypeScript installed in the
application and an existing tsconfig. They can update the selected tsconfig and
`prnext-env.d.ts` to connect generated route declarations and missing Next-style
type aliases, preserving existing/inherited settings. `typecheck` checks semantic
errors even if `typescript.ignoreBuildErrors` is configured.

A successful production build still needs request and browser verification.
Test navigation, interaction, hydration and the application's important error
paths. Keep `.prnext/`, `.prnext-types/`, `.prnext-dev/` and `.prnext-cache/` out
of Git; keep the project's reviewed lockfile in Git. Do not delete generated
directories while another process is using them.
