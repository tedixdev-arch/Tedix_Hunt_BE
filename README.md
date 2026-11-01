# TedixHunt API App

`apps/api` contains the first runnable TedixHunt Node.js API foundation.

## Technology

- TypeScript
- Node.js 24 LTS supported development and runtime baseline
- Express
- REST/JSON
- Vitest and Supertest

## Local commands

From the repository root:

- `npm run dev:api` starts the API on `API_PORT` or `3001`.

## First Admin bootstrap

After configuring `DATABASE_URL`, provision the first Admin from a trusted server shell:

```sh
TEDIX_BOOTSTRAP_ADMIN_PASSWORD='<strong-password>' \
npm run bootstrap-admin -- --email admin@example.com --name 'Admin'
```

The source command is intended for development and server operations where dev dependencies are
installed. A built-only deployment can run the same command as
`node dist/scripts/bootstrapAdmin.js --email ...`. The `--password` option remains available for
development and tests, but avoid it on shared or production shells because command-line arguments
may be exposed in shell history and process listings. If an Admin already exists, the command
refuses to continue unless the trusted operator supplies `--allow-additional-admin`.

## Endpoints

- `GET /health`
- `GET /api/health`

Both return the shared health-response contract. The API uses JSON middleware, JSON 404 responses, centralized JSON error handling and restricted CORS when `WEB_ORIGIN` is configured. PostgreSQL is not connected yet, and no product features or Tedix integration are implemented.

## Required JWT signing configuration (D07)

From this repository, run `npm run dev` or `npm run build && npm start`.
Copy `.env.example` to a private `.env` and supply `JWT_SECRET` before starting.
The server loads `dotenv/config` before importing application configuration:
process/service environment values take precedence over `.env`. The migration and
Admin bootstrap entry points also load dotenv and import the same configuration,
so they require this setting too. Direct library imports read the process environment.
There is no alternate key variable, generated runtime key or test-mode fallback.

The existing JWT algorithm is HS256. Generate **at least 32 cryptographically random
bytes** (256 bits), represented as hex or base64, using a trusted password/secret
manager or `openssl rand -hex 32` in a private operator session. Store it in the
service's protected environment or a restricted `.env`/secret store; never commit
it, paste it into tickets, put it in command-line arguments, or print it in CI.
All persistent instances serving the same tokens must use the same stable key.

Validation requires at least 32 UTF-8 bytes, no leading/trailing whitespace, at
least eight distinct characters, no repeated whole pattern, and no obvious markers
such as `change-me`, `replace-me`, `replace-with`, `your…secret`, `jwt-secret`,
`placeholder`, `example`, `password`, `disposable`, `test-only`, `default`, `insecure`, `super-secret`, `not-a-secret`,
`abcdefghijklmnopqrstuvwxyz`, `0123456789`, `1234567890` or `qwerty` (case and separators
are ignored for marker checks). This is a guard against clear misconfiguration,
not an entropy estimator: a long human phrase is not a substitute for random bytes.
The value is used exactly as supplied, never trimmed or decoded.
Invalid/missing configuration throws `Invalid JWT_SECRET` before database startup
or the HTTP listener. Errors do not include the supplied value.

Vitest alone loads `src/test/setup.ts`, which explicitly assigns a new random
32-byte disposable key before application imports, replacing any inherited key.
The same runtime rules apply even with `NODE_ENV=test`. No application entry point
imports this setup. CI separately generates an ephemeral key into `GITHUB_ENV`
without printing it so the migration command can validate configuration; this key
is scoped to the test job and never supplied to deployment jobs.

Run `npm test` for regression coverage. To include PostgreSQL suites, set
`TEST_DATABASE_URL` to an **entirely disposable** PostgreSQL 17 database with a
CREATEDB role. The migration suite resets its public schema; other integration
suites create/drop isolated databases. Never point these tests at a persistent DB.

### Deployment release gate and safe verification

`.github/workflows/backend.yml` preserves the server `.env` during rsync and runs
build, migrations and a systemd restart on both deployment targets. No Docker or
systemd unit configuration is checked into this repository. The actual service
environment, working directory and deployed key quality have **not** been inspected.
Before merge (which triggers dev deployment), the authorized operator must verify
that both the remote migration process and `tedixhunt-api` service receive a stable,
securely generated key meeting these rules. Missing/unsafe values now stop migration,
bootstrap or service startup; a failed migration stops the workflow before restart.
Do not weaken validation to bypass this gate.

1. In the service's actual working directory and environment, run the built
   configuration check below. It reports only success/failure; do not use `printenv`,
   `echo`, shell tracing or key dumps. Do not pass the key on the command line.

   ```sh
   node --input-type=module -e 'import "dotenv/config"; try { await import("./dist/config/environment.js"); console.log("JWT configuration valid"); } catch { console.error("Configuration invalid; check protected settings"); process.exitCode = 1; }'
   ```

2. Confirm secure random generation/storage through operator records, without
   reading or disclosing the value. Passing structural checks alone cannot prove
   entropy. If unknown, keep release blocked for operator remediation. This task
   does not generate or rotate production keys. Any separately authorized key
   replacement invalidates existing access JWTs and requires coordinated rollout.
3. In a disposable checkout with no `.env`, run `npm start` with `JWT_SECRET` unset
   or set to `change-me`: expect a nonzero exit with `Invalid JWT_SECRET`, no
   listening message and no supplied value in output. The automated startup tests
   cover this without touching deployed settings.
4. After separately reviewed merge/deployment, use disposable accounts to verify
   native login, protected authorization and refresh rotation; check health and
   readiness. Record results without tokens/keys. D07 remains pending review,
   merge and verification; this PR does not establish deployed security.

## Authentication abuse protection (QA-02 / A4)

Configurable per-process token buckets cover public authentication/account-creation
routes. Enforcement defaults **disabled**, including production. See
[QA-02 evidence, provisional budgets and operator activation gate](docs/QA02_Authentication_Abuse_Protection.md)
and `.env.example`. Confirm actual ingress/trusted proxies, instance counts,
classroom traffic and approved limits before enabling; no production activation
or automatic guest cleanup is included.

GeoNames catalog: [pgAdmin SQL package and import guide](docs/GeoNames_pgAdmin_Import.md) (draft; compatibility gates apply).
