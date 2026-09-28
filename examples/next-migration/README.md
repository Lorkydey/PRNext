# Next.js migration examples

These small applications exercise different Next.js features with deterministic sample data:

- `boutique`: product catalog, optimized images, client cart, Server Actions, cookies and API routes.
- `journal`: Pages Router, French/English content, SSG/ISR, SSR search and shallow navigation.
- `dashboard`: Cache Components/PPR, personalized Suspense content and intercepted routes.
- `boutique-node`: a variant of the catalog with the `/edge` page using the Node.js runtime.
- `portail`: dynamic SSR, cookies, proxy, JSON APIs and streaming Suspense.
- `documentation`: static pages, ISR, on-demand revalidation and a search API.

## Run an example

From an example directory, install its dependencies and run the existing Next.js scripts:

```sh
npm install
npm run dev
```

For a production build, use `npm run build` followed by `npm start`.

To try PRNext, install `prnext@alpha` in a copy of the example, then run:

```sh
npx --no-install prn migrate --dry-run
npx --no-install prn migrate
npx --no-install prn check
npx --no-install prn dev
```

Use `npx --no-install prn build` and `npx --no-install prn start` for production mode. See the [package README](../../packages/prnext/README.md) for runtime and React version requirements.

PRNext is an experimental alpha with partial Next.js compatibility. These examples help check specific features; they do not guarantee compatibility with every application.
