# Task 5A validation evidence

Base: exact GitHub main `4ec0f8e3bf4d650b859a5c5459afd5d65ab5d329` (merged #94), verified via GitHub connector. No FE changes, merge, deploy or publication enablement.

## Environment and limitations

Dedicated disposable `postgres:17` container on localhost port 55435, separate from application data. Each new integration suite creates/drops its own database; the existing migration suite uses the dedicated test database. Tests use real Express requests, signed access tokens, actual user/account lookup and real PostgreSQL constraints/transactions. No database/auth mocking in the new route suite. The calculation unit tests use explicit hypothetical policies; they do not validate GPS trust or enable policy. A trusted-writer database fixture verifies evidence persistence and separation from completion; it is not an HTTP GPS grant.

Initial sandbox restrictions denied Docker and local sockets. Approved execution escalation resolved both. No infrastructure skips are claimed as passing tests. Direct `git fetch` could not connect to the inherited proxy; GitHub connector reads supplied merged #94 files and signed Git metadata instead. The reconstructed local commit and complete tree hashes match upstream main exactly. The Draft PR is created via GitHub APIs with that main as its parent; no mirror/synthetic commit is included.

## Checks

- Full backend suite: **66 files / 1,480 tests passed, zero skips** (final run 64.61 seconds). New coverage: 11 real Express/PostgreSQL tests plus five calculation/snapshot tests. Existing migration regression suite now includes migration 030.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `TEST_DATABASE_URL=<disposable PostgreSQL URL> node docs/validate-participant-access.mjs`: passed. All **30 compiled migrations** applied to an empty pre-migration baseline; repeating applied **zero**. Separate complete `src/db/schema.sql` bootstrap passed, including new access tables/trigger. Both temporary databases dropped.
- Runtime Swagger: **74 paths**, four implemented Participant access operations, local references resolved. No proposed challenge delivery/attempt/hint/progress paths registered. Schema clearly describes disabled new enrollment and GPS grants.
- `git diff --check`: passed.

Reproduce after `npm ci`/`npm run build` using a disposable PostgreSQL instance with a CREATEDB test role: set `TEST_DATABASE_URL`, run `npm test`, then `node docs/validate-participant-access.mjs`. The checker generates a fresh in-process JWT signing secret and never prints it. The suite's own setup supplies test JWT configuration; runtime typecheck/build require no secrets.

## New security and compatibility evidence

Actual Express/PostgreSQL checks cover concurrent trusted model enrollment (one UUID/no duplicates/no Team); parallel existing-member rejoin and initialization; fresh-request and fresh-app persistence; cross-Hunt identity/UUID isolation; valid-code public resolution without enrollment; unknown/invalid code; professional roles without membership; unauthenticated, wrong token type, blocked and retired users; existing guest identity rejoin; all lifecycle states; unknown input/authority fields; invalid GPS numeric ranges/types, dates and accuracy; unresolved-policy denial for syntactically valid old/future/inaccurate observations; direct future and FinishPoint verification rejection; no proposed attempt endpoint; immutable source/version pin; scoped foreign keys; mandatory verification evidence; no challenge definition leakage; and retained Organizer/Admin boundaries.

Calculation checks cover Haversine distance, antimeridian/poles, inclusive/exclusive radius boundary, per-checkpoint radius, and both unapproved uncertainty alternatives with explicit hypothetical age/accuracy. Original Signal still has six regular entries plus the playable seventh FinishPoint, no invented coordinates, no snapshot mutation. Starter terminal identity also remains compatible.

There is **no successful public new-enrollment test or positive HTTP GPS-grant test** because those behaviors are deliberately unavailable under unresolved D7/D1/D6. The DB fixture does not establish physical presence. All GPS grant and future advancement paths remain disabled. See [foundation decisions and next dependencies](Participant_Access_Foundation.md).

## Documentation correction: checkpoint radius standard

The approved default for new TedixHunt checkpoints is **25 m**. Existing immutable Hunt snapshots retain their stored radii; calculation fixtures with other radii exercise boundary behavior and do not define the new-checkpoint default. Creator/Organizer/Admin radius overrides and editing are a separate upcoming task. GPS accuracy, freshness and grant policy remain unresolved, and GPS grants remain disabled. This correction changes documentation only; no historical snapshot, runtime code or test fixture was changed. Documentation diff and `git diff --check` were verified; the backend checks above describe the preceding implementation validation and were not rerun for this documentation-only correction.
