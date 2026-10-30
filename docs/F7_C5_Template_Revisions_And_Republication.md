# F7/C5 — Creator revisions and atomic Universal republication

Based on latest main `7663dc95170e12b25cd17f9ad0771819c43f8906`, including merged C1–C4 (#76–#79). Inspected the approved F7 proposal, C1–C4 documents, Creator validation/routes/model, independent Admin reviews, C1 immutable category/provenance constraints, and C4 copy locking before implementation. The current request authorizes C5 over earlier documents reserving revision design. No merge or deployment.

## Publication and candidate authority

Previously `status = approved` plus `submitted_version` served both lifecycle and C3/C4 publication resolution. Moving that identity into draft/submitted/changes_requested would hide its existing publication. The two fields cannot safely serve both purposes.

Migration `023_template_publication` adds one nullable `hunt_templates.published_version` referencing an exact immutable version of the same identity. Only Creator-owned Universals can carry it. The existing version table, lifecycle and review process remain authoritative; there is no third category, release table, second approval or publishing step.

| Field | Meaning in C5 |
| --- | --- |
| `status` | Current authoring/review state: draft, submitted, changes_requested or approved. |
| `submitted_version` | Exact submitted candidate/last decision artifact. Cleared when saving a new draft after a decision, preserving the existing SQL draft constraint. History remains in immutable version/review rows. |
| `published_version` | Last independently approved Universal artifact, preserved through all candidate transitions. Null for Local and legacy Templates. |

Saving a version allocates the next integer and inserts a complete immutable snapshot under the owner-scoped identity lock. Approved Universals and classified changes_requested Templates can begin a new draft; Local corrections retain existing geographic validation. Submitted candidates remain uneditable. Approved Local revision is not activated. Legacy unclassified state transitions retain their prior restrictions.

Submission still requires draft state, valid category-specific content and the exact latest requested version. Admin review reads only `submitted_version`. Approval changes status, replaces the Universal publication pin with that submitted version, and inserts independent review evidence in one transaction. A failed review insert rolls back status and publication together. Request-changes records its exact decision without changing publication. Correcting it requires a new immutable version before resubmission.

The C3 library and C4 copy resolver now join `published_version` and its exact independent approved decision, regardless of candidate status. They return one current product per Universal, without version history or a historical-selection override. Latest/MAX(version) is never publication authority.

## Migration and retention safety

The additive migration backfills only approved Creator Universals with exact independent approved evidence at the old submitted pin. A later unreviewed saved version is ignored. Evidence-free or self-approved historical states fail closed. No historical category is inferred, and no content, owner, source provenance, existing review, timestamp or Hunt snapshot is rewritten.

A deferred constraint trigger requires exact independent approval when publication changes, permitting the existing update-plus-review-insert transaction. Publication cannot be cleared through candidate authoring. Classified review UPDATE/DELETE is prohibited; legacy review SQL behavior remains unchanged. API deletion returns 409 for published Universals or classified identities with review history, including corrected drafts, preserving historical evidence. Existing C1 identity/version/provenance triggers and restrictive source FKs remain intact.

Apply migration 023 before code that reads the new column. Rolling code back to C4 after candidate authoring can hide still-published Universals because C4 uses the old status/pin predicate; coordinate any rollback rather than deleting the column or rewriting history. No live rollout or rollback was performed.

## API and errors

Existing Creator endpoints and envelopes remain in place:

- `POST /api/creator/templates/{key}/versions` accepts `{ content }`; 201 saves a full next snapshot. Approved Universal or classified changes_requested state becomes draft. Draft response/owner reads show the new candidate and null submittedVersion. Library detail independently exposes the current publishedReference. No client publication/ownership/category/provenance fields are accepted.
- `POST /api/creator/templates/{key}/submit` accepts `{ version }`; existing latest-version, content and ownership checks apply. Candidate submission does not change the Library product.
- Admin `POST /api/admin/templates/review/{key}/approve` and `/request-changes` accept `{ "version": N }`. For both classified categories, N is required and must equal the inspected submitted candidate under lock. Missing, stale, repeated or non-reviewable decisions return 409 `template_not_reviewable`. Malformed decision bodies/version values return 400 `invalid_input`. Reviewer identity always comes from persisted authentication; extra body identity fields cannot replace it.
- Legacy Admin decisions can omit version and retain their existing pin-based behavior, including ignoring a supplied alternative version. Classified clients must send the inspected version; this is a deliberate stale-review protection requirement.
- Self-approval remains 403 `template_self_approval_forbidden`. Existing self-request-changes remains allowed. Creator mutations require persisted active non-guest Creator capability; other-owned/absent/platform authoring keys remain indistinguishable 404. Invalid candidate content remains 400; noneditable/nonsubmittable states or wrong latest version remain their existing 409 contracts.
- C4 retains 201 copy, 404 unavailable source, 409 `stale_published_reference` and destination conflict contracts. A v1 reference becomes stale after v2 publication, even if a newer unapproved candidate exists.

OpenAPI decision/authoring descriptions are updated. There is no internal historical-version selector in the Creator Library.

## Transaction and locking strategy

Authoring, submission, Admin decisions and C4 all continue locking the same Template identity `FOR UPDATE`. C4 still locks identity first and resolves publication in a separate statement after any wait, then share-locks exact immutable content/review rows and atomically inserts Local identity/version/provenance. No lock ordering or C1 source identity binding is replaced.

If copy serializes first, it commits a consistent old artifact and original provenance before republication. If approval serializes first, copy's fresh resolution observes the replacement and rejects an old expected reference with 409. Existing Locals remain independent persisted snapshots; neither publication nor authoring updates their source content/provenance. Local/Hunt snapshot propagation is absent.

## Verification

Dedicated disposable PostgreSQL 17 container `tedix-c5-test`, local port 5545; suites create/drop isolated databases as supported by the existing harness. No live database accessed.

Final verification: **54 files / 1,037 tests passed, zero skips** in 23.56 seconds with `TEST_DATABASE_URL` pointing at the disposable server. `npm run typecheck`, `npm run build` and `git diff --check` passed. Earlier runs identified the existing draft constraint (the new draft must clear submitted_version) and legacy review-body compatibility; both were corrected before the passing final run.

Coverage includes:

- v1 remains visible during v2 draft/submission and after request-changes; v3 correction/resubmission independently publishes exact v3 even with an internally saved v4.
- Single current Library product, ignored history query override, copying the published artifact during pending review and after approval, stale copy/review rejection, owner isolation, persisted-role revocation and self-approval prevention.
- Both deterministic copy/republication lock orders with actual blocked PostgreSQL transactions, plus exact v2 copies after approval.
- Injected approval-review insertion failure rolls back the publication/status atomically; existing Local rows/content/provenance and earlier review bytes remain unchanged.
- Local corrections reject incomplete geography, allow complete independent review, and keep classified Organizer selection closed. Classified review/history deletion guards remain effective.
- Migration from existing C4 data, exact evidence-backed backfill, idempotent migration rerun, fresh-schema constraint/trigger equivalence, unchanged legacy/Signal and saved Hunt history.
- Full Backend regression suite, typecheck, build and diff checks.

## Remaining G4/D10 decisions

G4 still owns canonical locality/geographic identity, route evidence, validity, safety and Local eligibility. D10 still owns eligible Local Organizer selection and controlled activation. Classified catalog/geography/direct Hunt-selection gates remain closed. No Local publication to Organizer selection, automatic Universal creation/extraction, new category, revision propagation, FE, Participant runtime, withdrawal workflow, merge or deployment is included.

## F7-BE-01 private publication projection

The existing owner-scoped `GET /api/creator/templates` and
`GET /api/creator/templates/{key}` now expose `publishedVersion` for Universal
Templates directly from `hunt_templates.published_version`. An integer is the
exact retained publication, including through draft, submitted and
changes_requested candidates; null explicitly means no publication. The latest
candidate `version`, `content` and `submittedVersion` retain their meanings.
Local and legacy records omit the new field. A missing field on a Universal
from older/unsupported data must remain unavailable, never be interpreted as null
or inferred from candidate state. Mutation response envelopes are unchanged.

See [F7-BE-01 contract and verification](F7_BE_01_Retained_Universal_Publication.md)
for examples, security evidence and limits. C5 persistence, approval, copying,
revision and deletion behavior is unchanged; no migration is introduced.
