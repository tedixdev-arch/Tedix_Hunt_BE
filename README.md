# TedixHunt API

Node.js 24 LTS, TypeScript and Express. Step 7.1 adds the PostgreSQL foundation;
the existing authentication and organization routes still use MongoDB.

## Setup

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` for your PostgreSQL database.
3. Set `MONGODB_URI` and the existing JWT settings to preserve legacy product routes.
   Without MongoDB, those routes return a JSON 503 promptly; they are not migrated
   to PostgreSQL in this step. If a configured MongoDB is unreachable, startup fails.
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
`src/lib/postgres.ts`. Existing Mongoose models are compatibility code only;
new work must use PostgreSQL.

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
5. Check existing login/organization flows with the configured legacy database.
6. Validate clean termination and record the deployment result before step 7.2.

The previous source contained a MongoDB credential and printed its URI. This step
removes that code, but repository history is unchanged. Rotate that credential in
the database provider and configure the replacement through deployment secrets.

See [the scoped task and review workflow](docs/step-7.1-task.md).

Library references: [node-postgres pool](https://node-postgres.com/apis/pool) and
[node-pg-migrate API](https://salsita.github.io/node-pg-migrate/api).
