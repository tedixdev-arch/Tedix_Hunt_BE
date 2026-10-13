# Creator starter catalog

`GET /api/creator/templates/starters` uses the existing authentication and Creator
capability middleware and returns `{ items: [{ key, displayName, description,
createdAt, creationPath }] }`. Each creationPath is an existing POST route.
The fixed registry includes only the two shipped starters, never persisted
Creator drafts. Listing performs no Template/Hunt reads or writes and needs no
schema change. Existing creation, ownership, versions, review and snapshots retain
their existing behavior.

## Metadata and timestamp provenance

| Key | Metadata source | Creation date |
|---|---|---|
| `signal-cluj-napoca` | `signalClujNapocaV1.ts`: key, displayName and mission.briefing; registered POST in `routes/creatorTemplates.ts` uses `createSignalClujNapocaStarter` | `null`: neither the starter definition nor its route records starter creation/registration time |
| `signal-overload-cluj-napoca` | `signalOverloadClujNapocaV1.ts`: key and displayName; short description summarizes its mission.briefing; registered POST uses `createSignalOverloadClujNapocaStarter` | `null`: neither the starter definition nor its route records starter creation/registration time |

The definitions, factories, route registration, migrations and existing starter
documentation were inspected. Migration 017 persists canonical **platform**
Signal v1. Its `hunt_templates.created_at` and version `created_at` defaults record
installation in each database, not creation of the separate geographic Creator
starter. Overload has no migration/seed registration. Creator draft row/version
dates record individual copies and cannot establish either starter's date. There
is no verified starter creation timestamp in the inspected sources, so both dates
remain unknown. No Git/PR date, server clock or inferred historical date is used.
Only add a non-null ISO timestamp after verifying the starter creation or
registration event, and document the evidence here for that starter.

Known timestamps sort by instant descending; unknown dates sort last. Equal
instants and unknown dates sort by ascending stable key using code-point order,
independent of server locale. Currently Signal precedes Overload solely because
both dates are unknown and its key sorts first. Names and versions do not imply
chronology. Sorting returns fresh metadata objects and leaves definitions intact.

## Validation

Validated from current GitHub `main` at
`82c7a6b6408a1306175cab82d8726aebe3d81e55`.

| Check | Result |
|---|---|
| `npm test -- src/domain/templates src/routes/creatorTemplates.test.ts src/lib/swagger.test.ts` | 7 files, 142 tests passed |
| `npm test` | 42 files passed, 2 skipped; 786 tests passed, 33 skipped |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `git diff --check` | Passed |

The initial sandbox run blocked Supertest local HTTP listeners with `EPERM`;
focused and full tests passed with local-port sandbox escalation. Typecheck
caught a new test returning a Supertest response; the test was corrected before
the successful checks.

The existing PostgreSQL suites skip 24 migration tests and 9 integration tests
when `TEST_DATABASE_URL` is unset, as in this environment. Real database
integration was not executed. Running coverage includes both existing starter
POST contracts, Template lifecycle/ownership and Hunt snapshot tests. New tests
cover catalog authorization, exact keys/endpoints/names, unknown dates, mixed
date ordering, null/equal-date ties, timezone-equivalent instants, isolated
results and unchanged source/draft snapshots. The authenticated catalog test
asserts no SQL queries or pool connections and no Template model calls, so
listing cannot change persisted Templates, versions, Hunts or snapshots.
No migrations, starter content, persistence or FE code changed.
