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

## Endpoints

- `GET /health`
- `GET /api/health`

Both return the shared health-response contract. The API uses JSON middleware, JSON 404 responses, centralized JSON error handling and restricted CORS when `WEB_ORIGIN` is configured. PostgreSQL is not connected yet, and no product features or Tedix integration are implemented.
