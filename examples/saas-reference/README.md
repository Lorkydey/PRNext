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

Password forms apply atomic PostgreSQL budgets before password hashing or account
creation. The sign-in budget is five attempts per normalized email per minute,
with a global ceiling of 100 attempts per minute. Registration allows three
attempts per email and 20 globally per ten minutes. Account keys are HMACs using
the auth secret; email addresses are not stored in the counter table. Expired
account counters are removed in bounded batches, and the global ceiling bounds
new counter creation. A database failure refuses the attempt. These deliberate
reference limits can affect legitimate traffic and must be adapted to a product's
traffic and abuse policy. They do not depend on client-supplied IP headers.
Better Auth's HTTP endpoints also store their built-in rate limits in PostgreSQL,
so their counters survive worker rotation and are shared between workers.

Configure BETTER_AUTH_URL as the single public HTTPS origin behind a TLS proxy.
The reference middleware derives locale and sign-in redirects from that validated
origin, rather than the incoming Host or forwarding headers. Restrict origin
access to the trusted proxy, and make that proxy overwrite Host and all forwarded
headers. Do not expose the backend directly. OIDC requires an ID token verified
by Better Auth against discovery, JWKS, audience and the authorization nonce;
the reference refuses a userinfo-only fallback when the ID token is absent.

The isolated reference qualification uses a loopback HTTPS proxy with a publicly
known test certificate and key. Only its browser contexts accept that certificate;
it never installs a trust root or changes global TLS verification. The fixture
also checks invalid OIDC callbacks, CSRF rejection, revoked-session POSTs and
OIDC/revocation after standalone relocation and removal of the original source.
Never use the fixture certificate or key for an actual deployment.

This is a reference application, with account registration enabled. Add your
product's access policy, recovery and verification requirements before adapting
it for real users.
