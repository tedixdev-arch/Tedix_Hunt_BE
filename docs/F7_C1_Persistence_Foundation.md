# F7/C1 implementation candidate

Based on main 3db374ed75d278cdea868bfbb6807b27b1883942 after merged PR #75. Scope: persistence foundation only; no copy API, classified scratch route, publication/revision workflow, new review rules, eligibility rollout, FE or deployment.

## Schema candidate recorded before code changes

- Add nullable TEXT `category` to `hunt_templates` and `hunt_template_versions`, constrained to `universal` / `local`. NULL is legacy/unclassified, independent of `origin` platform/creator. No defaults, backfill or JSON rewriting. New legacy clients/starters continue inserting NULL.
- Identity category is insert-only, including NULL (no implicit legacy conversion). Classified identity UUID/key/origin/created_by_user_id are immutable; classified identities require creator origin and durable non-null owner. Existing user FK remains restrictive and retirement anonymizes rather than removes attribution.
- Every version must match the identity category using NULL-safe comparison. Classified versions must also match identity origin/owner. SQL triggers enforce this across helpers/direct SQL; classified version rows cannot be updated. Legacy content/update behavior remains unchanged except category and version-to-identity binding cannot be rewritten to smuggle classification.
- Reserve nullable identity columns `source_template_id` UUID, `source_version` INTEGER, `source_creator_user_id` UUID and `source_review_decision` TEXT. All four NULL for scratch/legacy; all non-null only for classified Local, with positive source_version and decision='approved'. These fields are insert-only and inherited through the owning identity by every Local version. No starterSource inference. Local content is independently stored in ordinary version JSONB, never live inherited.
- Restrictive composite FK source_template_id/source_version references exact source version and another references the exact review `(template_id, version, decision)` (add matching review uniqueness); restrictive user FK retains original source Creator. Insert trigger requires a different Universal source with matching original owner. These constraints preserve exact approved source provenance without choosing publication authority, concurrency tokens or copy transaction semantics. An approved review alone is NOT future copy eligibility. No source reference can be added to an existing identity; future copy must atomically create a new Local identity/version. Deleting a source with a dependent Local is restricted; deleting an otherwise-unused Local removes its own lineage with the identity, preserving existing draft deletion semantics.
- Add migration 022 only and mirror it in schema baseline. Existing 001–021 remain untouched. Add no publication/withdrawal/consent tables or states. Roll forward preferred; no destructive down migration or deployment in this PR.
- Add category IS NULL to both shared approved resolvers, covering list/geography/direct-key Hunt selection; classified Local stays closed alongside Universal regardless of approval. Legacy platform latest-version and Creator submitted-version pin behavior remain unchanged. Existing snapshots remain independent and untouched.

## Compatibility and validation

Disposable PostgreSQL tests will migrate legacy fixtures through 021→022 and fingerprint legacy versions, approvals, Signal and Hunt snapshots; test fresh baseline parity, category/owner/version/lineage constraints, dependency deletion and account retirement. Run existing Backend regressions, typecheck and build. No live data census or deployed E2E claim.

## Reserved decisions / limits

This is the user-authorized C1 candidate, not approval of unrelated D05-T or D09–D16. Publication mapping, category-specific submission validation, routes, safe public provenance projection, concurrency/copy workflow, revisions, withdrawal, Locality/evidence and G4 eligibility remain separate. Existing classified submission/review mechanics are not activated by routes in C1; SQL fixtures are not product activation. No automatic Signal classification. No deviation from approved product rules intended; source-review references implement only historical evidence, not a published product pointer.

## Implemented C1 evidence — 27 October 2026

The candidate above was committed and recorded in Draft PR #76 before any implementation change. The implementation follows that candidate: migration 022, SQL constraints/triggers and restrictive source references; category mappings in persisted model records; legacy-only shared approved resolution. No public creation input or copy operation accepts category/provenance in this slice. Existing helpers continue creating unclassified records; classified authoring/inherited version insertion is reserved for C2. Classified SQL fixture creation in tests is not workflow activation.

Changed files:

- `docs/F7_C1_Persistence_Foundation.md`: pre-implementation schema/compatibility candidate and results.
- `src/db/migrations/022_template_classification.ts`: additive category, ownership/version binding and source evidence/dependency constraints.
- `src/db/schema.sql`: matching fresh-schema foundation.
- `src/db/templateClassification.integration.test.ts`: isolated PostgreSQL migration, history, constraints, independent ownership/content, dependency, retirement, baseline parity and HTTP selection tests.
- `src/db/migrate.test.ts`: include 022 in migration/history expectations.
- `src/models/HuntTemplate.ts`: persisted category types/mapping and closed classified resolver gates.
- `src/models/HuntTemplate.test.ts` and `src/routes/huntTemplates.test.ts`: shared resolver SQL expectations.
- `src/routes/adminTemplateReviews.integration.test.ts`: transactional pre-021 simulation temporarily removes the new incoming review FK; rollback restores all constraints/history.

Validation against a disposable PostgreSQL 17 Docker container:

- Full Backend regression suite: **52 files / 1,018 tests passed, zero skips** (`TEST_DATABASE_URL=… npm test -- --reporter=dot`). The server was created only for this task; no live database was accessed.
- Dedicated C1 suite: **7 passed**, including exact before/after legacy identity/version/review/Signal/Hunt comparisons, migration rerun, SQL constraints, independent Local ownership/content and immutable lineage, source dependency rejection, account retirement, fresh-schema C1 constraint/trigger parity and actual catalog/geography/Hunt PATCH rejection for approved Universal and Local fixtures.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed.
- Existing migrations 001–021 unchanged. No historical JSON, approvals, Signal classification or Hunt snapshots rewritten. No FE changes, merge or deployment.

No known C1 implementation blocker or deviation from the recorded candidate/approved product rules. This remains a technical implementation candidate for review in Draft PR #76, not a claim that F7/G4/D10 is complete. In particular, source review evidence does not establish current publication/copy eligibility; unrelated D05-T and D09–D16 decisions remain unresolved. There is no live-data census, deployed E2E or rollback activation claim. Apply the additive migration before running code that queries category; any later rollout/rollback must preserve the recorded bindings and dependency history.
