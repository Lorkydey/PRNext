# PRNext reference workspace

A small bilingual application with Better Auth, PostgreSQL, Drizzle, next-intl
and authenticated Server Actions. Each account owns its notes. The dashboard
checks the session in both the middleware and the Server Component; mutations
also check it and derive ownership from the authenticated user.

## Run locally

Use a supported Node.js version and a PostgreSQL database reserved for this
application. From this directory, run:

    npm ci --workspaces=false

The lockfile pins the published 0.1.18-alpha baseline. This example currently
requires the unpublished 0.1.19 candidate. After npm ci, install both freshly
packed archives from the same validated source before running the application:

    npm install --workspaces=false --no-save --package-lock=false /path/to/prnext-candidate.tgz /path/to/matching-native-candidate.tgz

Use the native archive matching your operating system and architecture. Keep
the registry lockfile unchanged. Repository qualification performs these steps
in an independent temporary consumer; it does not qualify this application on
published 0.1.18-alpha.

Copy .env.example to .env.local. Set DATABASE_URL, BETTER_AUTH_URL and a random
BETTER_AUTH_SECRET with at least 32 characters. Never commit credentials.
The setup script reads the process environment; export these values when running:

    npm run db:setup

This initializes Better Auth's schema and the notes table. Review migrations
before applying them to an existing database.

Run npm run dev, then open /fr or /en. The same application can be built with
npm run build and started with npm start.

## Optional OpenID Connect

Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET to enable the sign-in
button. Register the callback /api/auth/callback/oidc with the provider.
Use HTTPS outside loopback development. The client secret stays on the server.
Use a test identity provider for automated scenarios.

## Sessions and deployment

Cookie caching is disabled so revocation is checked against PostgreSQL. The
application supports signing out other sessions. Session renewal follows Better
Auth's expiration and update-age settings; deploy database migrations separately
from application worker startup.

The standalone output prepares self-contained output. Keep the database and auth
environment available at runtime. Rebuild after changing the application or its
dependencies. Each initialized database module instance owns a pool bounded to
four connections. Middleware and rendering isolates can initialize separate
instances in the same process. Size database capacity for their total, across
all workers and deployments. PostgreSQL application_name identifies the process
and thread for private database observability; it is not exposed by an endpoint.

This is a reference application, with account registration enabled. Add your
product's access policy, recovery and verification requirements before adapting
it for real users.
