# A1 — Confirm the deployed setup

Status: implementation prepared; deployment verification remains pending owner merge.
Reference: Prototype Architecture & Implementation Plan v1.3, Phase A, step A1.
This document records observations from 16 September 2026, not a claim that A1 is complete.

## Confirmed baseline

- FE main inspected: `05cffb8b51834ec75b58879d509eb3c11cd2e9bb`.
- BE main inspected: `ad9ec318d437150b48e05be47f8845fafe1ffa22`.
- The FE repository contains the active React router and mockup screens. Its shared
  folder currently contains theme code, not a completed shared API/session client.
- https://tedixhunt.anainfo.ai/ returned HTTP 200 and served
  `/assets/index-CY87bRwM.js`, containing the merged “Yours city is waiting.” test.
  This confirms the test reached the public FE. It does not identify the exact
  commit of every deployed asset or explain the historical starting-screen mismatch.
- Both https://tedixhuntbe.anainfo.ai/api/health and
  https://tedixhunt-be-dev.anainfo.ai/api/health returned HTTP 200, version `0.1.0`.
  Before this change, these responses identified neither the commit nor DB readiness.
- Direct authorized read-only DB inspection confirmed `tedix_hunt` and its four
  public tables: `users`, `organizations`, `organization_members`, `refresh_tokens`.
  Only schema metadata was inspected; no account records, hashes or tokens were read.
  This direct connection does not prove the deployed backend targets the same DB.
- Live API responses to the FE Origin header lacked `Access-Control-Allow-Origin`.
  The earlier authorization preflight check also lacked permission headers, and
  the FE `/api/health` path returned 404. Browser-to-API access remains unverified.

## Changes in this PR

- `/health` and `/api/health` retain liveness behavior and add `revision`.
  Deployments write their full GitHub commit SHA into `dist/revision.txt` after a
  successful build and before restart. Local builds without that artifact report null.
- `/health/ready` and `/api/health/ready` return 200 only when a separate, bounded,
  read-only connection using the service's `DATABASE_URL` successfully runs `SELECT 1`.
  Missing configuration and connection/query failures return 503 with a generic body.
- Health responses are not cached. No credentials, target addresses, database names,
  SQL errors or user data are exposed by the diagnostics.
- These probes never call the existing startup schema initializer. That initializer
  and migration/backup/shutdown work remain for A2; no schema changes are in this PR.

## Deployment and responsibilities

1. Codex prepares changes, reviews the diff, runs checks and opens a PR.
2. The owner decides whether to merge. Codex does not merge or manually deploy.
3. The BE workflow runs build/tests for PRs. Deployment runs only on a push to main
   after tests succeed. The current target is `tedixhunt-be-dev.anainfo.ai`, user
   `deploy`, path `/var/www/Tedix_Hunt_BE`, service `tedixhunt-api`.
4. The workflow preserves the server `.env`, installs dependencies, builds, records
   the revision and restarts the service. Existing server settings are not replaced.
5. The owner confirmed FE merge-to-deployment automation; the visible text test
   corroborates it. FE main has no `.github/workflows` directory, so its deployment
   mechanism and logs still need to be recorded from the hosting configuration.

The latest BE target differs from the original hostname in the plan. Verify whether
both public BE hostnames reach this service; do not infer that from identical version strings.

## Post-merge verification to complete A1

- Confirm the BE test and deploy jobs succeed for the owner's merge commit.
- GET `/api/health` on both BE hostnames and compare `revision` with that commit.
  A null or older revision means the running build has not been verified.
- GET `/api/health/ready` on the intended public API; require HTTP 200. A 503 keeps
  A1 blocked. A 200 proves DB connectivity, not the intended DB identity/schema.
- Have the server operator verify that the service's `DATABASE_URL` targets the
  intended `tedix_hunt` database/user with the current credentials. Report only
  host/database/user, never the password or full connection string.
- Verify `WEB_ORIGIN=https://tedixhunt.anainfo.ai` in the running backend settings,
  or document a deliberate same-origin proxy. The app enables CORS only when
  WEB_ORIGIN is set. Recheck the actual browser request and authorization preflight;
  successful server-side HTTP requests alone are insufficient.
- Record the FE deployed commit and deployment mechanism; verify the visible home
  screen against the current active router and resolve any remaining discrepancy.
- Mark A1 complete only after the above evidence is recorded. Then begin A2.

## Validation before PR

- `npm run build`: passed.
- `npm test`: 23 tests passed, including readiness success/failure, connection cleanup,
  missing configuration, revision parsing and secret-free error responses.
- The compiled readiness function passed against the intended database using the
  authorized local credentials. It ran only a read-only `SELECT 1` and closed the connection.
- No server settings, application records, database schema or deployments were changed.
