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
npm run bootstrap-admin -- --email admin@example.com --password '<strong-password>' --name 'Admin'
```

The source command is intended for development and server operations where dev dependencies are
installed. A built-only deployment can run the same command as
`node dist/scripts/bootstrapAdmin.js --email ... --password ...`. If an Admin already exists, the
command refuses to continue unless the trusted operator supplies `--allow-additional-admin`.

## Endpoints

- `GET /health`
- `GET /api/health`

Both return the shared health-response contract. The API uses JSON middleware, JSON 404 responses, centralized JSON error handling and restricted CORS when `WEB_ORIGIN` is configured. PostgreSQL is not connected yet, and no product features or Tedix integration are implemented.
