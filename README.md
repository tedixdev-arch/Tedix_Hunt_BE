# TedixHunt API

Node.js 24 LTS, TypeScript and Express. PostgreSQL provides the identity and
authentication foundation. Organization routes still use legacy MongoDB/JWT code.

## Setup

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` for your PostgreSQL database.
3. Set `WEB_ORIGIN` to the exact FE origin. Set `NODE_ENV=production` on the server
   to enforce Secure refresh cookies. PostgreSQL authentication needs no MongoDB.
   `MONGODB_URI` and JWT settings apply only to legacy organization routes, which
   return 503 when MongoDB is disconnected. If configured MongoDB is unreachable,
   startup still fails until that legacy startup dependency is removed.
4. Run `npm run build`, then `npm run db:migrate` and `npm start`.
   Use `npm run dev` for development; migrations still run as an explicit command.

## PostgreSQL configuration

`DATABASE_URL` is required (for example, the local-only placeholder in `.env.example`).
`PGPOOL_MAX` defaults to 10 and accepts 1–100 connections. Connections time out after
3 seconds; SQL statements after 5 seconds; client query waits after 6 seconds.
The process checks connectivity before accepting HTTP traffic and closes both
database connections on shutdown.

For hosted databases use a provider-issued URL with verified TLS, such as
`sslmode=verify-full`, and the provider's trusted CA setup where required. Do not
disable certificate verification. Configure deployment secrets outside the repo.

New database access uses parameterized queries through `getPostgresPool()` from
`src/lib/postgres.ts`. Existing Mongoose models support only the remaining legacy
organization code; new work uses PostgreSQL.

## Migrations

The migration runner uses `node-pg-migrate`, ordered migration history in
`public.pgmigrations`, its default advisory lock, and a single transaction per run.
Run from the repository root after building:

- `npm run db:migrate`: apply pending migrations; repeat runs do not reapply them.
- `npm run db:rollback`: revert the most recent migration (review before use).

The initial migration records the foundation without creating product tables.
Add future timestamp-prefixed `.cjs` migrations under `migrations/`, exporting
`up` and `down`. Applied migrations are immutable. Ship that folder with `dist/`,
`package.json`, and the lockfile. Migration tooling is a runtime dependency so
deployment jobs can use `npm ci --omit=dev` after a build.
Run migrations once as a release step before starting the new API version;
application startup never alters schema. The deployment migration identity needs
schema/table creation rights; use narrower runtime permissions as tables arrive.

## Health and readiness

- `GET /health` and `GET /api/health`: unchanged process-liveness response.
- `GET /health/ready` and `GET /api/health/ready`: query PostgreSQL on each call.
  Success is HTTP 200 with `{"status":"ok","database":"up"}`;
  failure is HTTP 503 with `{"status":"unavailable","database":"down"}`.

Readiness measures PostgreSQL connectivity, not legacy Mongo availability or
schema version. Use readiness for traffic routing and liveness for process checks.
Configuration errors or unavailable PostgreSQL prevent startup; diagnostics never
print connection URLs or database exception details.

## Validation and deployment handoff

Run `npm test` and `npm run build`. Tests use source files only, excluding compiled
test copies under `dist/`.

GitHub CI runs the build and tests against a disposable PostgreSQL 17 service.
For local integration tests, build first and set `TEST_DATABASE_URL` to a dedicated
empty test database before `npm test`. Integration checks apply/rollback migrations
and must never target production. They are explicitly skipped when this variable
is absent. Generated `dist/` and TypeScript build state are not versioned; always
build before starting or migrating.

After the owner merges the PR:

1. Provision PostgreSQL, configure `DATABASE_URL`, preserve legacy `MONGODB_URI`
   and JWT settings, and build/install using the commands above.
2. Run migrations; rerun and confirm no additional migration is applied.
3. Start the service; verify `/api/health` and `/api/health/ready` return 200.
4. In a staging environment, interrupt PostgreSQL and confirm readiness becomes
   503 while liveness stays 200; restore it and confirm readiness recovers.
5. Validate the PostgreSQL auth flow described below. Legacy organization endpoints
   do not yet accept these new session tokens; their migration is a later step.
6. Validate clean termination and record the deployment result before step 7.2.

The previous source contained a MongoDB credential and printed its URI. This step
removes that code, but repository history is unchanged. Rotate that credential in
the database provider and configure the replacement through deployment secrets.

See [the scoped task and review workflow](docs/step-7.1-task.md).

## Core User schema (step 7.2)

The next migration adds `public.users`: UUID identity, case-insensitively unique
email, optional password hash/display name, and creation/update timestamps.
Role associations will reference the user ID in a later step; no role grants or
PostgreSQL authentication endpoints are introduced here. Existing MongoDB users
are not automatically copied. See [schema decisions and deployment prerequisites](docs/step-7.2-task.md).

Run the usual migration command to apply pending changes. Check existing server
tables first: this migration expects no existing `public.users` table. Its rollback
drops user data; do not use rollback on populated databases without an explicit
recovery plan and verified backup. Server deployment validation remains pending
until Hetzner access is available.

## PostgreSQL authentication (step 7.3)

`/api/auth/register`, `/login`, `/refresh`, `/logout`, and `/me` now use PostgreSQL.
The mockup-era creator/participant/guest auth endpoints are retired. MongoDB users
and tokens are not imported or accepted by this API. New registrations grant no
privileged role. FE integration is step 7.4/7.5; role authorization is step 7.6/7.7.

All auth POST requests require `X-TedixHunt-CSRF: 1`. If an Origin is supplied,
it must equal `WEB_ORIGIN` (or the directly served API origin if unset). Configure
`WEB_ORIGIN` explicitly behind a reverse proxy. Credentialed CORS is enabled only
for that configured origin. Serve FE and BE over HTTPS on the same site (for example
the same domain with an `/api` proxy, or sibling subdomains); SameSite=Strict refresh
cookies are deliberately not designed for unrelated FE/BE domains.

- `POST /api/auth/register`: JSON `{email, password, displayName?}`. Email is trimmed
  and lowercased. Passwords require at least 15 Unicode characters and at most 128
  UTF-16 code units / 512 UTF-8 bytes; they are not trimmed or truncated. Optional
  display names are trimmed. Extra fields, including role, are rejected.
- `POST /api/auth/login`: JSON `{email, password}`; wrong/unknown/passwordless
  accounts return the same 401 response.
- Both return `{user: {id, email, displayName}, accessToken, tokenType: 'Bearer',
  expiresIn: 900}`. Refresh tokens are only sent in an HttpOnly cookie.
- `GET /api/auth/me`: send `Authorization: Bearer <accessToken>`; returns `{user}`.
- `POST /api/auth/refresh`: include cookies (`credentials: 'include'` in browser
  fetch). Returns a new access token and rotates the cookie. Old access tokens stop
  working immediately. Serialize refresh calls across tabs/requests: using a consumed
  refresh token revokes the session, including when duplicate refreshes race.
- `POST /api/auth/logout`: include the refresh cookie or current Bearer token.
  Returns 204, revokes the session immediately and expires the cookie. Other login
  sessions are unaffected. Failed storage operations return 503 rather than claiming
  successful revocation.

Access tokens expire after 15 minutes, sessions after an absolute seven days;
refresh does not extend that seven-day limit. All tokens are random 256-bit opaque
values; only SHA-256 digests are stored. Passwords use Node's built-in scrypt with
random salts (`N=32768, r=8, p=3`), an
[OWASP-listed profile](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
Auth responses use `Cache-Control: no-store`. Keep access tokens in FE memory,
restore them through refresh after reload, and never store passwords or refresh
tokens in browser storage. This is a FE implementation requirement for the next steps.

Registration/login share a limit of 10 requests per IP per 15 minutes; session
endpoints allow 60 per IP per minute. Limits are in memory per API process and reset
on restart. Proxy headers are not trusted by default, so clients behind a proxy
may share its IP limit. Before deployment, configure trusted proxy addresses based
on the actual network and enforce edge limits; use a shared limiter before scaling
to multiple processes. Do not blindly trust client-supplied forwarding headers.

Operators should periodically remove expired session rows (refresh history cascades):
`DELETE FROM auth_sessions WHERE expires_at < CURRENT_TIMESTAMP;`. This is maintenance,
not an application startup action. Preserve consumed refresh hashes for unexpired
sessions so replay detection works. No cleanup job is installed on the server here.

OpenAPI: `/api/docs` and `/api/docs.json`. See [the task and review record](docs/step-7.3-task.md).
Email verification, password reset, MFA, role grants, Mongo-user migration and
deployment are not included in step 7.3.

Library references: [node-postgres pool](https://node-postgres.com/apis/pool) and
[node-pg-migrate API](https://salsita.github.io/node-pg-migrate/api).
