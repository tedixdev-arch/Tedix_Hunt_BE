# F7-BE-01 — Retained Universal publication projection

Product Owner authorized 30 October 2026. Based on BE main
`bcf1fda4153cc8ea787c4d7e5922f4cb4b34ee32`, verified through GitHub; the local
checkout matches that commit. Read the authoritative FE Master Execution Plan,
its frozen reconciliation, C2, C5, C6b-5 contracts/implementation, migration 023,
owner read SQL/mappers, authentication and Swagger before editing. No AGENTS.md
exists in the complete BE tree. Open-work search found FE Draft #125 and no BE
PR. FE #125 explicitly records the missing Universal publication projection.
Registration is isolated in [FE Draft #126](https://github.com/tedixdev-arch/Tedix_Hunt_FE/pull/126).
The frozen reconciliation/history is preserved. F7-BE-01 is the approved C5-based
prerequisite for completing F7-FE-02; #125 cannot complete Universal publication
acceptance until this contract is merged and verified. No FE #125 changes here.

## Contract

Both existing private owner GETs expose the same additive `publishedVersion`:

- `GET /api/creator/templates` — array of owner projections.
- `GET /api/creator/templates/{key}` — one owner projection or existing 404.

Only Universal records include it. Read `hunt_templates.published_version`
directly in the same statement as candidate fields. Migration 023 already binds
it to the exact immutable version and independently approved review; approval
updates that pin transactionally. Saving drafts, submission and request-changes
do not clear it. No latest/MAX, candidate status or submitted pin is used to
calculate publication. Existing fields and latest candidate content are retained.
No publication artifact content, history, catalog query or new endpoint is added.

| Value | Meaning |
| --- | --- |
| Positive integer | Exact retained Universal publication version |
| `null` on Universal | No retained publication |
| Omitted on Universal from older/unsupported source | Publication context unavailable; never assume no publication |
| Omitted on Local/legacy | Not applicable; existing Local approval projections/legacy shape preserved |

Examples below show only the relevant fields; all existing response fields remain:

```json
{"key":"unpublished","category":"universal","status":"draft","version":1,"submittedVersion":null,"publishedVersion":null}
{"key":"retained","category":"universal","status":"approved","version":1,"submittedVersion":1,"publishedVersion":1}
{"key":"retained","category":"universal","status":"draft","version":2,"submittedVersion":null,"publishedVersion":1}
{"key":"retained","category":"universal","status":"submitted","version":2,"submittedVersion":2,"publishedVersion":1}
{"key":"retained","category":"universal","status":"changes_requested","version":2,"submittedVersion":2,"publishedVersion":1}
{"key":"exact-pin","category":"universal","status":"approved","version":4,"submittedVersion":3,"publishedVersion":3}
```

The last example deliberately differs from latest version 4. NULL-category legacy
records still omit category; publication is never inferred from Signal, content,
location or old approved status. Local `localApprovedVersion`, `localApproval` and
`localSuspension` mappings are untouched. Mutation response envelopes remain
unchanged. Apply existing C5 migration 023 as required by the existing application;
there is no new schema, backfill or fallback for an unmigrated server.

## Authorization and compatibility evidence

Both routes retain `requireAuth` then `requireRole('creator')`. Authentication
reloads the persisted user and roles, rejects blocked/retired accounts, and does
not trust JWT role claims. Guests cannot exercise Creator capability. Both SQL
queries retain `t.origin = 'creator' AND t.created_by_user_id = $1`; detail also
requires `t.key = $2`. Other-owner and unknown keys return identical 404 bodies;
list excludes other-owner rows in SQL. Platform rows are excluded as before.

Disposable PostgreSQL HTTP tests cover successful private reads followed by
persisted Creator role revocation using the same JWT, absent authentication,
participant/Admin/Organizer-only actors, no role, guest, blocked/retired actors,
and another Creator attempting published detail/list access. No catalog enrichment
is used. This adds only read projection columns/mapping; approval, suspension,
revision, deletion, ownership and publication lifecycle code are unchanged.

## Changed files

- `src/models/HuntTemplate.ts`: optional typed publication field; direct pin selection and Universal-only mapping in the two private owner reads.
- `src/routes/creatorTemplates.ts`: GET OpenAPI descriptions.
- `src/lib/swagger.ts`: optional nullable integer property and availability semantics.
- `src/routes/creatorTemplates.integration.test.ts`: real HTTP list/detail consistency, null/publication retention/exact-pin assertions, authorization and Local/legacy regression coverage; extends existing C5 transaction tests.
- `docs/F7_C5_Template_Revisions_And_Republication.md`: links the additive private GET contract.
- This document: contract examples, evidence and limits.

## Verification

Commands executed with `TEST_DATABASE_URL` pointing to the isolated PostgreSQL 17
container `tedix-f7be01-test` (loopback port 5547):

- `npm test -- src/routes/creatorTemplates.integration.test.ts src/models/HuntTemplate.test.ts src/lib/swagger.test.ts --reporter=dot`: **3 files / 97 tests passed**, zero failures/skips.
- `npm test -- --reporter=dot`: **60 files / 1,257 tests passed**, zero failures/skips, 57.30 seconds. Includes C5 publication/transaction, C6b-5 Local continuity/suspension, authorization, legacy/Signal and Hunt regression suites.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.

Suites create/drop unique disposable databases; no live database is accessed.
The full suite emits an existing pg deprecation warning about concurrent queries
on one client; it does not fail or skip tests. Shell Git network access failed
(proxy unreachable), so GitHub connector reads and tree-based writes are used for
remote base verification and Draft PR delivery.

## Limits and review boundary

Only backend source/disposable DB evidence. No integrated FE acceptance, live
accounts, deployment, provider entitlement or real-device proof. This PR does not
complete F7-FE-02, F7 or downstream activation. Clients need the separately
reviewed FE implementation to consume the additive field and distinguish null
from missing. No merge or deployment. Stop for ChatGPT review.
