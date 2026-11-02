# Participation mode foundation — Task 6.1

Reviewed against BE main `87a7469a4be1f63b795eac703b8cd90512c6d598` (merged #110) and FE main `cdac4a6798a1498b226a831625e6211ec371370d`. The three Participant gameplay contract/decisions/sequence documents were inspected before implementation. This is setup persistence and fail-closed compatibility, not gameplay execution.

## Existing behavior and exact restrictions

- `src/domain/huntOptions.ts` advertised only Team/four and exported scalar validators. `src/routes/hunts.ts` rejected all other modes/sizes; `IHunt` and draft input types encoded that restriction.
- Migration 006 and the fresh schema enforced `hunt_format IN ('team')` and `team_size = 4`. Migration 035 replaces only those checks and adds Solo/null-size consistency. It does not add columns, update rows, modify migration 006, rewrite snapshots, or allocate fragments.
- `validateHuntForPublish` conflated configuration validity with Team/four runtime capability. It now validates saved configuration separately and explicitly keeps unsupported execution gated.
- HuntParticipant identity is already independent of Team membership. Team and team_members already use Hunt-scoped identity/composite constraints. No membership implementation changes are needed here.
- Universal/Local revisions, exact approval selection, Organizer source pinning and source/radius immutability remain in the existing models/migrations. Mode changes update Hunt setup fields only.
- Legacy Signal contains fixed four-contribution instructions and both Personal/Team content; definitions remain untouched. No fragment-count divisibility validation is introduced.

## Saved API behavior

Use the existing authenticated Organizer `PATCH /api/hunts/{id}` and subsequent GET/list responses:

```json
{"format":"solo","teamSize":null}
```

```json
{"format":"team","teamSize":3}
```

Canonical modes are `solo` and `team`. Selecting Solo without a size clears the previous Team size atomically. A non-null size with Solo is rejected; a size-only update against saved Solo is rejected. Team sizes are strict positive PostgreSQL INTEGER values (through 2147483647), with no coercion. This is a representation bound, not an approved member limit or live size policy. Partial drafts may retain null/unconfigured Team size; readiness requires applicable complete configuration. Historical null and Team/four rows are preserved unchanged by upgrade.

The SQL update guards size-only writes against a concurrently selected Solo mode; the database independently rejects a non-null Solo size. Mode changes remain draft-only. No Team is fabricated for Solo.

`GET /api/hunt-options` advertises both modes. `teamSizes: [4]` remains the historical pilot preset, not a variable-size allowlist or a claim that other sizes are unapproved architecture. No arbitrary new preset list/minimum/maximum policy is invented. Runtime Swagger documents configuration separately from execution readiness.

## Compatibility and remaining Product Owner decisions

Approved: independent Solo subjects, Team shared subjects, variable sizes, adaptive earned fragments and no divisibility exclusion. This PR saves these mode/size choices without implementing a second engine or fragment allocation.

- Solo publication remains blocked: current executable selections have no reviewed Solo path allowing required Team content to be omitted. The readiness message identifies D5. Even empty/Personal-only custom content remains blocked by the existing custom capability guard; this PR does not certify a new playable path.
- Non-four Team publication remains blocked with an explicit D2/D5 issue. D2 still needs formation/assignment authority, supported/incomplete roster limits, start readiness and active membership rules. D5 still needs mechanic-specific individual/collective binding, disclosure, recovery content and supported mode/size compatibility. Saving size 3 or 6 does not approve live activation of that size.
- Existing Team/four publication behavior is retained. This is historical compatibility, not certification that Legacy content implements the new adaptive/recovery contract.
- The existing custom-exercise publication guard remains active in every mode/size. Required Personal and Team slots, including FinishPoint, are preserved exactly; neither is silently discarded. Existing exact approvals, revisions and Local source protection remain active.

No admission/invitation, roster formation, GPS grants, delivery/checking, scoring/progression, fragment allocation/recovery, frontend redesign or Master/Implementation Plan update is included.

## Validation

PostgreSQL 17, disposable databases, authenticated Express requests, all migrations 001–035 in the new fixture and current integration suites. Upgrade checks compare complete historical Team/four and null rows before/after 035 and verify idempotent rerun. New cases cover Solo/Team save and reopen, sizes 2/3/4/5/6, malformed values, mode switching, no required Team membership, database constraints, blocked mode/content publication and unchanged pinned content.

The focused final run passed **342 tests in 10 files**:

```sh
TEST_DATABASE_URL=<disposable-local-postgres> npm test -- \
  src/routes/participationConfiguration.integration.test.ts \
  src/routes/hunts.test.ts src/domain/huntReadiness.test.ts src/models/Hunt.test.ts \
  src/routes/customExercises.integration.test.ts \
  src/db/organizerLocalTemplate.integration.test.ts \
  src/models/HuntTemplate.integration.test.ts \
  src/routes/checkpointRadius.integration.test.ts src/db/migrate.test.ts \
  src/lib/swagger.test.ts --maxWorkers=2 --testTimeout=15000
```

Creator/Organizer regressions include later versions preserving existing Hunt snapshots, immutable approved artifacts, Local source database protection, selection/publication races and radius freezing. The custom-content regression additionally exercises Solo, Team/3 and Team/4 without losing either classification. That file was rerun after extending its matrix: 34 tests passed. Typecheck, build and `git diff --check` passed.

Initial sandbox HTTP binding was denied; local test execution used approved socket access. An intermediate new upgrade fixture omitted mandatory status (corrected), and a loaded existing Creator workflow exceeded its default five-second timeout; the final command above passed with two workers and a 15-second per-test limit. No deployed/device/live gameplay acceptance is claimed.

Direct git fetch could not connect to the environment proxy. The GitHub connector supplied latest main; all 260 baseline file hashes were verified against its exact Git tree. The PR commit is based directly on that remote main, excluding the local synchronization commit and scratch logs.

## Necessary FE follow-up

FE `src/services/api/hunts.ts` types format as Team-only. `src/pages/generalSetup.ts` defaults to Team/four, requires a positive Team size in every mode, checks membership in `options.teamSizes`, and falls back to a local size when a saved size is null. A separate FE change must accept Solo, send/retain null size for Solo, preserve saved variable sizes without that allowlist check, and display backend publication blockers. Keep existing preset four and historical configuration; do not advertise a live capability from a saved option. No FE files changed here.

**STOP for ChatGPT review. Do not merge or deploy.**
