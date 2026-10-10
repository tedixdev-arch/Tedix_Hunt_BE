# Signal Cluj Creator draft starter

`POST /api/creator/templates/starters/signal-cluj-napoca` creates an ordinary
Creator-owned draft from the frozen server-side Signal: Cluj Napoca v1 fixture.
Authentication and the existing `creator` capability are required, including for
multi-role accounts. Admin or Organizer capability alone does not grant access.

No request body, or `{}`, allocates `signal-cluj-napoca-<UUID>`. An optional
`{"key":"my-signal-cluj"}` uses existing key normalization and validation (maximum
100 characters). Other input fields are rejected. Ownership, status and source
content cannot be supplied by the client. Existing keys, including the canonical
platform key, produce `409 {"error":"template_key_conflict"}` with no overwrite.
This operation is not idempotent when key is omitted; each successful request
creates a separate draft. A caller can use an explicit key and the existing
owner-scoped GET to resolve an uncertain retry.

The response follows the existing draft-creation envelope:
`{key, version: 1, status: "draft", origin: "creator", content}`. Reload and edit
through `GET /api/creator/templates/{key}` and
`POST /api/creator/templates/{key}/versions`. Submission and Admin review use
the existing endpoints and immutable version rules.

## Audit and mapping

- Canonical source: `src/domain/templates/signalClujNapocaV1.ts`, key
  `signal-cluj-napoca`, version 1. Migration 017 seeds the approved platform
  identity and verifies checkpoint SHA-256
  `e195aa63867d845ee772c476cb3aaa29cfc92c09739f2f8aadb62c98398456d4`.
  The factory imports this fixture rather than the latest database version.
- The first six gameplay entries receive `role: "normal"` and retain
  `checkpoint: 1..6`. The seventh receives `role: "terminal"`, retains both final
  puzzles, and loses its numeric checkpoint. The shared flat Personal/Team
  Challenge fields, story, answers, hints, solutions and top-level scoring are
  copied exactly. Both scoring eligibility arrays remain `[1,2,3,4,5,6]`.
- All original `direction`, `distance`, `navigationClue`, `nextLocation` and
  `navigationMode` values are retained under each entry's `fictionalNavigation`
  with `scope: "puzzle-only"`. Active `navigationMode` is `"none"`, and the other
  active navigation fields are absent. Puzzle answers such as WEST and the
  narrative's safety language remain fictional content, not walking guidance or
  safety certification.
- `configuration.normalCheckpointCount` is 6; `checkpointPositions` is empty.
  Geographic `finishPoint` is omitted because the existing draft validator
  requires a complete object whenever it is supplied. Terminal gameplay is
  present, but its physical FinishPoint still needs research.
- `starterSource` records canonical key/version/checkpoint digest.
  `routeResearch` marks research, physical verification and walking navigation
  `"pending"`, with an explicit explanation of the fictional content.
  New drafts also include `routeResearch.proposal`: seven ordered, sourced
  landmark candidates with exterior arrival descriptions and pending field checks.
  See [route proposal](signal-cluj-route-proposal.md). Landmark reference pins
  in that metadata never populate authoritative configuration geography.
- `createCreatorDraft` atomically inserts the new identity and immutable v1,
  using the authenticated Creator for both provenance fields. Existing unique
  constraints, owner-scoped reads, version locks, submission checks and exact
  submitted-version Admin approval are reused without modification.

## Limitations

No authoritative GPS coordinates, discovery radii, real walking distances,
verified route or safety certification are generated. The retained configuration description
`Outdoor · walkable city centre` belongs to the canonical scenario and does not
establish physical route verification. Creators must research real locations and
author six complete geographic positions and one complete FinishPoint in a new
draft version before submission passes existing geographic validation.

Research metadata is informational. Existing validation checks structural
completeness, not physical truth or certification; this change adds no new review
gate. The starter neither submits nor approves anything. No FE rendering for the
new fictional-navigation annotation, participant runtime, AI integration, catalog
redesign or Organizer UX is included. Canonical content, migrations, approved
versions, capabilities and existing Hunt snapshots are unchanged.

## Actual validation

Started from `bdea96b98fcaf58ac6b2fe58864f68279918e67c`, verified equal to remote
`main`. No prepared remote `signal-be` branch was found.

- Focused factory and Creator route tests: 79 passed.
- Full `npm test` with a disposable local PostgreSQL 17.6 database via
  `TEST_DATABASE_URL`: 740 passed across 40 files; no skipped tests.
- PostgreSQL suite: 24 passed, including starter concurrent-key conflicts,
  Creator provenance, generated-key uniqueness, owner-scoped reload/edit,
  incomplete-geography rejection, immutable v1/v2 round-trip, stale-version
  rejection, exact submission/review/approval and unchanged pre-existing approved
  rows and Hunt snapshots. Approval occurs only against synthetic test fixtures.
- Whole-object reconstruction tests verify every canonical checkpoint field,
  including fictional clues, is preserved; mutation isolation and the canonical
  digest remain intact.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed.

The disposable database and binary tooling are outside the repository; no new
runtime or development dependency is introduced. No merge, deployment, real
Template approval or publishing was performed.
