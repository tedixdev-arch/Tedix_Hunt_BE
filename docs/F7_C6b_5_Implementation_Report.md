# F7/C6b-5 implementation and acceptance evidence

Implemented against merged contract `F7_C6b_5_Local_Approval_Revision_Contract.md`,
main `5518197ae63b669d83226669f68b19f4ade17f85`. Delivery is one Draft PR;
merge, deployment and Organizer activation are outside this change.

## Schema and authority

Migration **027_local_template_approval** adds `local_approved_version` and the
four immutable suspension fields to `hunt_templates`. The same SQL appears in
`src/db/schema.sql`. No existing identity, version, review or Hunt is backfilled.
Local metadata is restricted to Creator Local identities, with exact composite
version FKs and a restrictive suspension-actor FK. Reasons are nonblank and bounded
to 1,000 characters; the server trims surrounding whitespace.

Immediate guards prevent pointer clearing/regression, arbitrary old-review promotion,
new evidence-less approved identities, loss/deletion of historical authority and
changes to an established suspension tuple. New approval requires the exact submitted
candidate. A deferred guard checks independent approved evidence and an active Admin
reviewer before commit; Universal publication and classified-review protection remain
unchanged. Compatibility capture allows an already approved historical pin only with
pre-existing independent evidence. A Local-only approved-review insertion guard now
requires an exact approval already in progress; normal promotion requires that no
decision already exists. Together these durable lifecycle/evidence rules prevent
fabricated historical evidence without `xmin` or transaction-ID inference. The capture
precedes candidate changes; the deferred check permits the resulting draft. Every
deferred identity event reloads and validates final authority, including pointer-unchanged
updates and compatibility captures. Historical reviewers can subsequently retire without
destroying existing evidence. See [the guard review](F7_C6b_5_Authority_Guard_Review.md)
for the reproduced bypass, integrity argument and adversarial SQL acceptance cases.

Controlled deletion retires an account referenced only by suspension attribution.
Retained Local pointers/audit tuples prevent deletion even during replacement drafting.
The fresh-schema submitted-version FK existence check is scoped to its table, so a
fresh schema in a separate namespace does not accidentally reuse another schema's FK.

## API behavior

- Existing Creator version saving now permits approved Local replacements. Exact
  prior authority/snapshot survives drafting, submission and `changes_requested`.
  Evidence-less/self-evidence historical approvals return
  `409 template_approval_evidence_required` before any candidate mutation.
- Local submission and approval require a stored binding. Both lock and compare
  current identity, country code and numeric coordinates with the saved snapshot,
  and require an active Locality. Text-only name/country-display/administrative-context
  drift is accepted without rewriting saved JSON. Approval rechecks completeness.
- `POST /api/admin/templates/{key}/suspend` accepts only `{version, reason}`.
  The version identifies retained approval authority, including resolvable evidence-less
  historical authority. Stale/absent authority and repeated suspension return
  `409 template_eligibility_conflict`. Server actor/time and exact suspended version
  are recorded atomically. Replacement approval never clears suspension.
- Creator/private Admin representations add `localApprovedVersion`, `localApproval`
  (authority/evidence/binding status), and `localSuspension` for Local identities.
- `GET /api/admin/templates/review/{key}?view=approved` returns the retained exact
  Local artifact, including during drafting/suspension. `candidateVersion`,
  `candidateStatus`, and `submittedVersion` describe the candidate separately;
  `currentLocality` is separate registry context. Missing/unresolvable historical
  pins return an explicit `integrity_exception` with null artifact version/content.
  Default submitted inspection/queue semantics remain unchanged.

## Read-only compatibility inventory

The reproducible query is [sql/local-approval-inventory.sql](sql/local-approval-inventory.sql).
It runs in a read-only transaction before migration 027 in the disposable PostgreSQL
acceptance suite. It reports overlapping evidence, binding and pin-integrity dimensions;
these are not mutually exclusive categories. MAX(version) is used only to flag an
inconsistent historical pin, never to select approval authority.

| Disposable historical fixture | Independent evidence | Pin resolves | Bound | Pin inconsistency |
| --- | --- | --- | --- | --- |
| historical-bound | yes | yes | yes | no |
| historical-evidence | yes | yes | no | no |
| historical-evidence-free | no | yes | no | no |
| historical-self | no | yes | no | no |
| historical-inconsistent | no | yes | no | yes: newer stored row |
| historical-missing | no | no | no | yes: missing pin |
| historical-unresolvable | no | no | no | yes: unresolved pin |

**Results:** 7 approved Local fixtures; 2 independently evidenced; 5 without independent
evidence (including self-review and integrity exceptions); 6 without a Locality binding;
3 missing/inconsistent pin references. The missing/unresolvable fixtures deliberately
simulate pre-existing corruption before 027 by relaxing and restoring the old constraints
as NOT VALID in the disposable database only. Ordinary current constraints already
prevent creating those records. This is test setup, not a repair/backfill procedure.

No production database was available or inspected. These counts describe seeded test
fixtures only and establish no production prevalence. All historical version/review/Hunt
fingerprints survive migration/rerun. Historical compatibility and integrity exceptions
remain explicit; no evidence is invented or pin repaired.

## Transactions and acceptance coverage

All writes use one pooled client/transaction, locking the Template identity first and
re-reading state after lock waits. Geographic transitions then lock Country → Locality
in shared mode through commit and recheck membership. Catalog writes never acquire
Template locks. Candidate/pointer/review/audit writes commit together or roll back,
including deferred PostgreSQL failures; pooled connections remain reusable.

`src/db/localTemplateApproval.integration.test.ts` contains 61 PostgreSQL tests and
`src/db/localTemplateAuthorityGuards.integration.test.ts` adds 29 adversarial SQL tests.
Existing Locality/classification/Creator/Admin/publication/catalog/Hunt suites are retained.
Coverage includes:

| Contract section 7 requirement | Evidence |
| --- | --- |
| Upgrade/rerun/fresh parity and no backfill | Pre-027 inventory, unchanged version/review/Hunt fingerprints, null defaults, new constraint/function parity |
| SQL integrity | Composite ownership, wrong category, unapproved/self/non-Admin/missing evidence, clearing/regression, old-review promotion and fabricated historical approval rejected |
| Locality transitions | Missing binding; inactive/country/coordinate drift at submission and approval; saved snapshot retained on each descriptive-only change |
| Revision continuity | Approved v1 → v2 → changes requested → v3 approval, A → B locality switch only at independent approval |
| Historical compatibility | Lazy unbound capture; evidence-less/self approvals blocked before writes and suspendable; missing/unresolvable authority never chooses latest |
| Suspension | Exact actor/version/reason/time, bounded input, stale/repeated/conflicting actions, immutable tuple, approval/reactivation retain suspension, retained deletion dependencies |
| Real concurrency | Save/submit, two approvals, approve/request-changes, duplicate suspension; both deterministic approve/suspend orders; catalog writer-first approval and transition-first submit/approve locks |
| Rollback/cleanup | Injected review/pointer/audit writes and real deferred commit failure; state preservation and reusable pooled clients |
| Existing regressions | Capability/ownership/guest/blocked/retired checks; Universal C5/C4, legacy, Signal, classified Organizer gates and exact historical Hunt snapshots |

## Validation

Executed on disposable **PostgreSQL 17.10**, using `TEST_DATABASE_URL` and unique
per-suite databases. The supplied root database contains only disposable test state.

- Focused PostgreSQL suites: **90 passed, 0 failed, 0 skipped** (Local approval and
  adversarial authority guards).
- Complete suite: **1,166 passed, 0 failed, 0 skipped**, 59 files.
- `npm run typecheck`: pass.
- `npm run build`: pass.
- `git diff --check`: pass.

No tests remain unavailable. These are application/PostgreSQL results, not deployment,
provider-entitlement or end-to-end rollout evidence. There are no functional deviations
from the approved contract. No reinstatement/reset, new rejection workflow, Mapbox,
frontend, Organizer selection, Universal publication changes or historical backfill is
implemented. Stop for ChatGPT PR review.
