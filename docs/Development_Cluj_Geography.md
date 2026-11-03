# Development prototype geography: Cluj-Napoca

After normal BE migrations, explicitly select the independently verified development
connection in `DATABASE_URL`, then run:

```sh
NODE_ENV=development npm run seed:development:cluj
```

This opt-in command is never called by startup, migrations, build or deployment.
Other NODE_ENV values (including unset) are rejected before database access by the
CLI. Do not point the command at production. No external provider or worldwide
GeoNames download is needed.

The seed uses the existing countries, geographic_regions, geographic_cities,
geographic_city_names and localities tables. It supplies Romania (RO), Cluj (13),
Cluj-Napoca (681290), and catalog coordinates 46.7712, 23.6236. Its import manifest
explicitly identifies curated development data; population 0 is an unknown-value
sentinel, and source_modified 2026-11-03 identifies this seed revision, not a claim
about a downloaded GeoNames release. Attribution: GeoNames (CC BY 4.0),
https://www.geonames.org/681290. Catalog readiness means a nonempty committed
catalog exists, never worldwide/countrywide coverage.

The command reuses an existing mapping or a unique active canonical locality
matched by normalized name, stored catalog aliases or GeoNames identity. Existing
locality UUIDs, labels, coordinates, provenance and timestamps remain unchanged.
If no candidate exists it registers one reference. Ambiguous, inactive,
cross-country, conflicting-source or already-elsewhere-mapped references fail
atomically and require explicit Admin reconciliation. The seed does not reactivate
or merge records. Existing catalog data is retained; incomplete existing imports
are rejected. Concurrent calls serialize with the normal importer and registry
writers. Repeating a successful call creates no further imports or localities.

Use this command instead of the older `scripts/development/cluj-locality.sql`
manual locality-only setup when the Creator country/county/city catalog is needed.
Existing manual Cluj UUIDs are reused. The older script alone does not make the
geographic catalog ready. Do not use its remove action on a canonical UUID still
needed by saved content.

Verify through existing authenticated Creator endpoints:

- GET /api/geography/countries
- GET /api/geography/regions?countryCode=RO
- GET /api/geography/cities?countryCode=RO&admin1Code=13&q=cluj
- GET /api/geography/cities/681290
- POST /api/geography/cities/681290/resolve with an empty JSON body

Organizer discovery remains on /api/organizer/geography/{countries,regions,cities}
and the existing C7 resolver. A seeded locality alone supplies no Organizer
inventory. Only an independently approved, currently eligible Creator Local
artifact mapped to this UUID makes the city visible there. Drafts, pending reviews,
suspended or materially changed localities remain ineligible. No approval,
review, version, draft, Hunt or saved snapshot is written by the seed.

## Eligibility evidence

The available managed local development database was inspected read-only before
the test run on 2026-11-03: one approved **platform** template, zero Creator templates,
and zero Hunts. Therefore no eligible approved Cluj-Napoca Local Hunt exists in
that database. No deployed development database connection is configured in this
environment; its inventory is **unverified**, not assumed absent. Synthetic approval
in the tests is limited to disposable databases and is not evidence of real
prototype eligibility. This PR does not apply the seed to any deployed database.

## Validation

`src/scripts/seedDevelopmentCluj.integration.test.ts` exercises real PostgreSQL:
concurrent/repeated seeding, Creator country/county/city/resolve endpoints,
canonical UUID reuse with differing historical coordinates, ambiguity/inactivity
rollback, nondevelopment rejection, existing-import preservation, incomplete-import
rollback, unchanged draft/version/review/legacy Hunt data, independent test review,
and C7 Organizer exclusion/inclusion/suspension.

Run with TEST_DATABASE_URL set to a disposable PostgreSQL service with CREATE
DATABASE permission, followed by `npm run typecheck` and `npm run build`.

Validated on 2026-11-03: complete BE suite **76 files / 1,680 tests passed**,
including all seven new seed tests and existing C6b/C7 regressions; no tests
skipped. `npm run typecheck`, `npm run build` and `git diff --check` passed.

### PR #116 CI teardown correction

The initial Actions run passed all 1,680 assertions but failed on an unhandled
PostgreSQL 57P01 from the package integration suite's forced database drop.
The reported client was closing (`_ending: true`, `_ended: false`): pg-pool
removes clients from its bookkeeping before their sockets finish closing, so
awaiting Pool.end() alone did not make WITH (FORCE) safe. Every package suite
database has a unique UUID name; no other suite targets it for deletion.
Parallel execution can affect timing but does not share that database.

The package suite now waits up to five seconds for its own pg_stat_activity
session count to reach zero, then drops the database normally. A leaked session
fails teardown; no PostgreSQL error handler, test disabling or serialization
was added.

After the correction, locked dependency installation, build, typecheck, fresh
disposable baseline and all 37 migrations passed. The complete BE suite with
PostgreSQL and two concurrent Vitest workers passed all 76 files / 1,680 tests
with zero unhandled errors.
