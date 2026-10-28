# F7/C2 — Creator-owned Universal and Local scratch authoring

Implementation candidate based on `main` **81f914dd95dd0a78fef651e61aab758c316a0f6b** (merged PR #76; includes product-contract PR #75). This slice implements scratch draft authoring and the existing submit/independent-review conventions. It does not complete F7 → G4 → D10 or activate classified Organizer selection.

## Inspected authority and implementation

Before coding, inspected `src/routes/creatorTemplates.ts`, `src/domain/creatorTemplates.ts`, `src/models/HuntTemplate.ts`, Admin review and Hunt selection routes, C1 migration 022/schema, authorization, existing tests, and both F7 reference documents. Also inspected FE `docs/TedixHunt_Prototype_Architecture_Implementation_Plan.md` from FE main commit `efe9c282a45bdfcd7b9bd36451270d068d6bdb62`, particularly F7, G4, D10, section 14 and staged delivery. The current user request authorizes this C2 implementation candidate; it does not resolve publication, copying, revision or geographic governance design.

C1 already supports identity category, exact version category/owner binding, immutable classified versions, immutable source provenance and closed shared approved resolvers. No schema deficiency was found; **no migration or schema change** is required. Existing migrations remain untouched.

## API contract

Existing authenticated endpoints are extended; there is no parallel lifecycle:

| Operation | Request | Result / constraints |
| --- | --- | --- |
| `POST /api/creator/templates` | `{ "key": "my-template", "category": "universal", "content": { ... } }`; category can instead be `local`, or omitted | 201 creates one Creator-owned draft identity and immutable version 1 atomically. Key normalization/conflicts retain existing rules. Explicit null/other categories return 400. Owner comes exclusively from authentication. Scratch source fields remain SQL NULL. |
| `POST /api/creator/templates/{key}/versions` | `{ "content": { ...complete next snapshot... } }` | 201 inserts next immutable version under the existing identity lock, inheriting its persisted category and owner. Client content key/version must exactly match identity/allocated next version. Only owned `draft` is editable. |
| `POST /api/creator/templates/{key}/submit` | `{ "version": 2 }` | Existing latest-version check, lock, validation and exact submitted-version pin; returns 200. Wrong latest version or state returns existing 409 error. Incomplete/invalid content returns 400 without changing state or pin. |
| Owner GET list/detail | Unchanged paths | Classified records include category; legacy records omit it, preserving the existing response shape. Owner SQL scope remains authoritative. |
| Admin queue/detail/approve/request-changes | Unchanged paths and decisions | Classified artifacts include category alongside the exact pinned snapshot. Existing persisted Admin authority, independent approval and immutable review record remain in force. Approval does not establish publication/library availability or Organizer eligibility. |

Creation/version/submission envelopes accept only the documented fields. Category is accepted only on creation. Payload attempts to set ownership, origin, state or source provenance are rejected with 400, including reserved top-level content metadata (`category`, `origin`, `owner*`, `createdBy*`, `created_by_*`, `source*`, `submittedVersion`, `status`). Existing `starterSource` content remains supported; it is not Universal lineage. Ordinary nested narrative/mechanics remain extensible JSON and cannot override authoritative metadata. No semantic plagiarism detection is claimed.

Create/save/submit responses add `category` only for classified Templates. Category is also exposed on owner authoring reads and Admin review artifacts so reviewers can distinguish the validation contract. Historical/legacy responses keep the existing shape; no category is inferred from geography or Signal content.

All authoring continues through persisted active non-guest Creator capability. Admin-only, Organizer-only, Participant-only and JWT role claims do not grant it. Another Creator receives the existing indistinguishable 404 for authoring another owner's Template. A combined Creator/Admin cannot approve its own submission (403 `template_self_approval_forbidden`); another authorized Admin can approve it. Existing self-request-changes convention is unchanged.

## Smallest category validation contract

All drafts use the same existing framework requirements: exact key/version, nonblank displayName/theme, nonempty mission/configuration/scoring objects, nonempty valid checkpoint array. Existing optional mechanic fields remain optional; typed gameplay validation still activates on count, positions or explicit checkpoint roles. No new Universal narrative, puzzle, scoring or mechanic fields are required.

| Category | Draft | Submission |
| --- | --- | --- |
| Universal | Existing framework and geographic draft validation. Fixed route fields may be omitted. | Same framework checks; no required fixed route, position completeness or FinishPoint. If normalCheckpointCount is supplied, retain existing complete numbered gameplay checks: N unique normal `checkpoint` entries in 1..N (optional checkpointNumber must match) and exactly one unnumbered terminal entry. Supplied geographic values still pass the existing draft validator; optional/partial valid positions do not imply an approved physical route. |
| Local | Same progressive draft contract; complete geography is not required to save. | Require the existing geographic contract explicitly, never the legacy no-count bypass: normalCheckpointCount 1–20, exactly N uniquely numbered positions, one complete FinishPoint, matching N normal gameplay entries and exactly one unnumbered terminal entry. |
| Omitted category | Legacy unclassified identity and versions; same framework draft rules. | Preserve legacy submission behavior, including pre-geography content without count/positions. Existing geographic completeness remains required when that contract is present. |

Existing geography bounds are preserved: nonblank names up to 100 characters, finite latitude/longitude within ±90/±180, radius 5–500 m; FinishPoint radius is an integer, normal position radius retains existing finite-number support. Supplied malformed objects are rejected, never defaulted or normalized. Classified submission additionally revalidates the exact persisted framework snapshot, preventing internally inserted malformed content from bypassing the normal save contract.

This safely reuses existing validation by separating optional Universal geography from counted gameplay completeness and making Local opt into the already supported complete geography contract. No incompatibility requires weakening shared validation. It does **not** claim canonical Country/Locality identity, geographic safety certification or G4 evidence validation.

## Persistence, compatibility and closed eligibility

Identity plus version 1 are a single transaction. Subsequent saves lock the same owner-scoped identity and insert full snapshots, explicitly carrying its category. C1 triggers enforce category/owner binding and immutable classified identity/version metadata. No client can relabel legacy or classified identities through these endpoints. Scratch provenance remains absent; future Local saves inherit identity lineage rather than accepting payload replacements.

Submission continues to select only the latest explicitly requested immutable version and atomically pin it. Admin review/decision joins that pin, never a newer arbitrary version. Submitted/approved records remain uneditable under this workflow. There is no revision/republish or changes-requested resubmission shortcut.

C1 `category IS NULL` approved-resolution gates remain unchanged and cover catalog, geography and Hunt selection. Both classified categories stay closed even after independent approval. Legacy catalog, platform Signal, starter factories, historical versions/reviews and saved Hunt snapshots remain unchanged. No historical backfill, classification or rewrite occurs.

## Changed files

- `docs/F7_C2_Scratch_Authoring.md` — API, validation, scope, evidence and remaining decisions.
- `src/domain/creatorTemplates.ts` — reserved metadata rejection and category-specific submission completeness.
- `src/models/HuntTemplate.ts` — atomic classified creation, inherited category on version saves, category-aware submission, owner/Admin category projections.
- `src/routes/creatorTemplates.ts` — explicit optional category, protected request envelopes, classified response metadata and inline OpenAPI.
- `src/lib/swagger.ts` — authoring/review category and validation contract documentation.
- `src/models/HuntTemplate.test.ts` — existing persistence expectations include the explicitly persisted legacy NULL category.
- `src/routes/creatorTemplates.integration.test.ts` — real PostgreSQL/HTTP C2 acceptance tests in a unique disposable database.

## Validation results

Run against a dedicated disposable **PostgreSQL 17** Docker server with `TEST_DATABASE_URL` supplied; no live database accessed. The new suite creates a unique database, runs baseline plus all migrations through 022 and drops that database afterward.

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `TEST_DATABASE_URL=… npm test -- --reporter=dot` — **53 files / 1,028 tests passed; zero skips**.
- `git diff --check` — passed.

The 10 new C2 integration cases cover Universal/Local creation and immutable version category consistency; null scratch lineage; owner scoping and persisted-role authorization (including revoked roles, guests, blocked/retired accounts and multi-role Creator); Universal submission with no fixed geographic route, including counted gameplay without positions/FinishPoint; complete Local submission and rejection of missing contract/positions/FinishPoint/gameplay; forged metadata/invalid category/malformed geography/unsupported typed gameplay; exact latest-version pin and review evidence; independent Admin approval and self-approval rejection; post-submission edit rejection; approved classified catalog/geography/direct Hunt selection exclusion; omitted-category legacy submission and both unclassified Signal starters.

Existing C1 migration/history/constraint tests and the entire legacy/Signal/Hunt/review/auth regression suite also passed. Earlier verification found four mock expectations needing the new explicit NULL category parameter and a new Hunt-selection fixture missing its Hunt organizer role; both were corrected before the passing full run. These were test setup/expectation issues, not relaxed authorization or selection rules.

## Unresolved technical decisions / deliberate boundaries

No C2 implementation blocker remains. This candidate chooses the existing supported geographic structure as the minimum Local submission contract and allows optional valid Universal geography without certifying a route; reviewers should assess that explicit narrow choice.

Publication authority/product-library representation, Universal → Local copy and concurrency/provenance resolution, original-owner revision/republish, changes-requested resubmission, withdrawal, canonical Locality/provider identity, geographic evidence/validity/safety governance, G4 eligibility and D10 activation remain unresolved/out of scope. No new approval/withdrawal states, provider search, frontend, Organizer/Participant runtime changes, merge or deployment are included. Existing D07 operator configuration gates are unchanged. This is source and disposable-database evidence, not deployed end-to-end verification.
