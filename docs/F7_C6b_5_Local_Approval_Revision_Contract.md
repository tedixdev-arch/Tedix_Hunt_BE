# F7/C6b-5 — Local approval and revision continuity contract

**Proposed contract for ChatGPT review — documentation only, 28 October 2026.**
No implementation, merge, deployment or Organizer activation is authorized here.

## 1. Baseline and current implementation facts

Reviewed BE main `9c20270f90cb31ed450eb7638eed9578d1d262a2`, including
[C6b-4](F7_C6b_4_Locality_Binding_Contract.md),
[C6a](F7_C6a_Hybrid_Locality_Contract.md), migrations 018–026,
[Template model](../src/models/HuntTemplate.ts),
[Universal publication/copy](../src/models/PublishedUniversal.ts),
[Creator routes](../src/routes/creatorTemplates.ts),
[Admin review routes](../src/routes/adminTemplateReviews.ts), and
[schema](../src/db/schema.sql).
The [FE Master Implementation Control Plan v3, reconciled 28 October 2026](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/53a3e376025adb161e28430a4d6c8ebe35644218/docs/TedixHunt_Master_Implementation_Control_Plan_v3.md),
especially §§5, 8–9, supplies the approved continuity policy. Its binding progress
statements predate BE migration 026; current code governs implemented facts.

- Template status is `draft | submitted | changes_requested | approved`.
  Versions are complete immutable classified snapshots. Owner-scoped identity
  locks serialize append and submission; submission pins the requested latest
  version in `submitted_version`.
- Migration 026 stores Local-only paired `locality_id` and
  `locality_snapshot`. Explicit selection snapshots an active stored Locality
  under Country → Locality shared locks. Omission inherits the prior pair exactly;
  null clears it in a new draft. Snapshot facts exclude current `active`.
  Country has no active flag; the initial reference is RO only.
- Admin reads and decisions resolve the submitted row, including its saved pair.
  Classified decisions require the inspected version. Approval forbids the original
  Creator as reviewer, including combined Admin/Creator accounts. Request-changes
  currently allows self-action. Reviews record exact version, actor, decision and
  time; classified review UPDATE/DELETE is protected.
- Submission/approval currently impose no Locality requirement or current-catalog
  comparison. Approved Local revision is forbidden; classified changes-requested
  correction is allowed. There is no reject, suspend or reinstate operation.
- C5 `published_version` is Creator-Universal-only, FK-bound and guarded by deferred
  independent-approval evidence. It survives candidate revision and request-changes.
  Local approval never populates it. Universal copy preserves exact source provenance.
- Organizer catalog, geography and direct Hunt selection remain gated by
  `category IS NULL`. Approved classified Local eligibility is a future authority,
  not a currently exposed catalog. Existing Hunt snapshots are stored exact artifacts.
- Stored Country/Locality and independent manual-proposal approval exist. Proposal
  approval alone does not bind or approve a Template. No provider persistence is needed.

Inspected PostgreSQL assertions in
[Locality binding](../src/db/templateLocalityBinding.integration.test.ts),
[publication](../src/db/templatePublication.integration.test.ts),
[Creator lifecycle](../src/routes/creatorTemplates.integration.test.ts),
[Admin review](../src/routes/adminTemplateReviews.integration.test.ts),
[geography](../src/db/geography.integration.test.ts), and
[Hunt catalog/snapshots](../src/routes/huntTemplates.integration.test.ts).
These cover immutable pairs, inheritance, locks, rollback, exact reviews, Universal
continuity, category gates and historical snapshots. They do not prove the proposed
Local continuity below. No application/PostgreSQL tests were run for this document.

Review-evidence rules were rechecked in [migration 021](../src/db/migrations/021_template_review_decisions.ts),
[migration 022](../src/db/migrations/022_template_classification.ts) and
[migration 023](../src/db/migrations/023_template_publication.ts).
Migration 021 deliberately creates no historical review backfill. Reviews have a primary
key on (template_id, version), so a version has one decision, and decision is restricted
to approved/changes_requested. Migration 022 adds the exact-decision unique key used by
C4 source-review FKs; it does not remove the primary key. Migration 023 freezes classified
reviews and requires exact independent approval for Universal publication. Status alone
is therefore not evidence of an independent review. Preserve all these rules unchanged.

## 2. Candidate lifecycle and exact approved authority

Add a Creator-Local-only `local_approved_version` pointer on the Template identity.
Reuse existing append, submit and independent exact-version review mechanisms.
Keep Universal `published_version`, its guard, PublishedUniversals and C4 provenance
unchanged. No Local publication table or additional release step.

For an evidence-backed Local, approval authority is the version referenced by this
pointer, including that version's immutable Locality pair. It remains eligible under
this approval-continuity contract unless explicitly suspended. Candidate status,
submitted_version and latest version never substitute for it. Existing historical
compatibility authority is handled separately in §5; neither path opens Organizer gates.

| Transition | Candidate status / submitted pin | Prior approval authority |
| --- | --- | --- |
| First draft / owner appends replacement | draft / null | Absent, or unchanged previous pointer |
| Submit complete bound latest version | submitted / exact version | Unchanged |
| Independent approve exact submitted version | approved / retain reviewed pin | Replace pointer atomically |
| Request changes | changes_requested / retain reviewed pin | Unchanged |
| Owner appends correction | draft / clear submitted pin | Unchanged |
| Explicit Admin suspension | Unchanged | Retained but ineligible |

Reuse `changes_requested` for every nonapproval decision. There is no separate
rejected decision, endpoint or lifecycle state. Correcting a reviewed candidate requires
a new immutable version and another submission; the old version is never resubmitted
or edited. An initial changes-requested candidate has no eligible approval.

Allow approved Local owners to append replacements through the existing version-save
path, as for approved Universal revisions. Preserve previous approval before clearing
the candidate pin. Drafting, submission, request-changes and Locality changes cannot
withdraw that approval. While suspended, candidate editing/review may continue, but
even a new approval preserves suspension. Reinstatement is explicitly deferred (§5).

## 3. Minimum proposed schema and API changes

The later implementation needs one additive migration and matching fresh schema;
this documentation changes neither.

| Addition on hunt_templates | Integrity |
| --- | --- |
| Nullable local_approved_version INTEGER | Composite FK (id, version) to this Template's exact version, ON DELETE RESTRICT; populated only for Creator Local. |
| Nullable local_suspended_at, local_suspended_by_user_id, local_suspension_reason, local_suspended_version | All absent or all populated; populated only for Creator Local with a resolvable approval authority. Server time, restrictive user FK, bounded nonblank reason, exact composite version FK. Presence means suspended; no additional boolean. |

The four suspension fields are one immutable audit tuple recording who suspended,
when, why and which exact version was authoritative then. Once set, they cannot be
cleared, overwritten or changed by authoring/approval. This is sufficient for one
suspension with no reinstatement in this slice; repeated cycles are not supported.
No audit table, new review decision, review-reason column or general workflow abstraction.
Controlled deletion must recognize the retained suspension actor dependency and retire
that account rather than attempt hard deletion. Retained approvals/audit tuples block
Template deletion even when the candidate is draft/changes_requested.

A deferred Local pointer guard requires an exact independent approved review for every
new pointer target, matching approved candidate status and submitted pin at approval.
Never clear an established pointer, move backwards or reference another Template.
The guard must distinguish the narrow pre-operation compatibility capture in §5 from
a new approval; that capture still requires existing exact independent review evidence.
Explicitly exclude NULL-category and Universal identities from Local metadata.

Reuse Creator create/version/submit and Admin approve/request-changes bodies and paths.
No new authoring or decision endpoint. Add approved reference, compatibility/evidence
status and suspension state to private owner/Admin responses, separate from candidate
content. Reuse `GET /api/admin/templates/review/{key}` with an explicit
`view=approved` option for inspecting the retained exact approval artifact even when
the candidate is draft or suspended. Default submitted-view and queue behavior stay
unchanged. Return saved content/pair; current registry facts are separate context.
This is private inspection, not classified Organizer selection.

Only one new write operation is proposed:
`POST /api/admin/templates/{key}/suspend` with
`{"version":1,"reason":"Explicit eligibility decision"}`.
Version is the approval authority inspected, not the candidate. Server derives actor
and timestamp. No arbitrary pointer/snapshot/status inputs or unsuspend option.
No reinstate endpoint or generic eligibility-action endpoint in this slice.

Preserve persisted active non-guest Creator authorization, owner-scoped nondisclosure,
and authoritative Admin review/suspension checks. Combined Creator/Admin accounts
cannot self-approve. Existing self-request-changes remains allowed; protective
self-suspension may also be allowed because it cannot grant approval.

Use the existing error envelope and lifecycle/stale-version errors. Proposed Local
errors: 400 locality_required for absent binding at submission; 409 locality_unavailable
for missing/inactive registry identity; 409 locality_geography_changed for material
mismatch (§4). Approval of an old unbound submission also fails locality_required.
Malformed body → 400 invalid_input; self-approval → existing 403
template_self_approval_forbidden; stale/missing inspected review version → existing
409 template_not_reviewable. Suspension with stale authority, no resolvable authority
or already suspended → 409 template_eligibility_conflict.
Evidence-less historical revision → 409 template_approval_evidence_required (§5).
Unknown/platform keys retain 404; Local-only writes must not affect Universal/legacy.

## 4. Submission, Locality validation and exact review

Retain all existing gameplay/geographic completeness checks. For every new Local
submission, lock the owner-scoped Template, require draft and the requested latest
version, then validate its stored Locality FK/snapshot pair. A proposal ID, route
geography string or client snapshot is not a binding.

At submission and approval, lock Country → Locality, re-read membership/activity
under locks and compare precisely these facts:

| Fact | Required check |
| --- | --- |
| Locality identity | version.locality_id = snapshot.id = current localities.id; the referenced row must exist. UUID is never reassigned to a different place. |
| Operational availability | Current localities.active must be true. No country-active check exists in today's schema. |
| Material geography | snapshot.countryCode equals current country_code; snapshot.latitude and snapshot.longitude numerically equal current stored coordinates. Both coordinates must remain finite and within existing bounds. |

Country code and representative latitude/longitude are the material geographic fields
available in this schema. Any coordinate change is material for this minimal contract;
no distance threshold, geocoder or fuzzy-equivalence rule. Compare numeric values,
not JSON serialization. The representative point is not a route boundary or safety proof.

`name`, `countryDisplayName` and `administrativeContext` are descriptive text.
Changes to those fields alone must not block submission/approval or force a new version.
Administrative context is currently a free-text label, not a canonical subdivision ID;
do not infer geographic equivalence or reassignment from spelling changes.
A true change of place must use a different UUID; a country/coordinate correction
triggers the material checks above. A future canonical subdivision/boundary policy
would need separate review. An Admin who discovers a real identity ambiguity must
request changes rather than silently treat it as a harmless label edit.

Admin reviews the exact submitted immutable content and saved snapshot, with current
registry facts/activity shown separately. A descriptive rename does not rewrite or
replace the artifact being approved. Existing snapshot-shape rules still apply;
allowing text drift is not permission to inject malformed snapshots.

Approval requires the inspected version to equal submitted_version, repeats the
Locality/material/completeness checks, rejects self-approval, and atomically writes
approved review, candidate status and Local pointer. No new version is created.

If Locality is deactivated between submit and review, approval fails locality_unavailable
without status/review/pointer writes. Request-changes remains available regardless of
inactive/unbound binding. The Creator must append a usable version and resubmit, or
the same identity can be legitimately reactivated before a later approval attempt.
Material drift fails locality_geography_changed: request changes and explicitly refresh
the binding in a new version. Descriptive-only drift remains approvable using the original
snapshot. No review or registry change silently refreshes historical JSON.

A replacement may change Locality A to B. The entire B version needs independent review;
until approval commits, A's exact prior approval remains authoritative. Request-changes
preserves A. Approval switches authority to exact B atomically. Inherited stale/inactive
bindings may still be saved in drafts under C6b-4, but cannot pass new transition gates.
Current registry corrections/deactivation never automatically withdraw an existing
approval; Admin suspension is the explicit withdrawal mechanism.

## 5. Suspension, deferred reinstatement and historical evidence

Suspend under the Template identity lock, require the expected exact authority version,
and set the four audit fields together. Retain the approval pointer and all approval
reviews. local_suspended_version records the authority at suspension, even if a later
candidate approval moves local_approved_version. That new approval stays suspended.
A retry cannot overwrite the original actor/reason/time/version.

**Reinstatement is deferred explicitly.** There is no clearing/reset API or direct-SQL
operational workaround in C6b-5. Locality reactivation, owner saves and independent
approval do not lift suspension. Later reinstatement must be explicitly reviewed before
suspension rollout is accepted operationally. At minimum it will require independent
Admin authorization, expected current approved version, active/material Locality checks,
and preservation of suspension/reinstatement history. Do not add cycle storage now or
promise same-version unbound reinstatement. This bounded choice avoids an unsafe reset
that destroys the only audit record.

**Historical approvals need two distinct compatibility cases:**

- With exact independent approved review: when local_approved_version is null and
  status=approved, preserve the existing submitted_version as the compatibility authority,
  even if its Locality pair is absent. Before first replacement save, capture that same
  exact version into the pointer in the same locked transaction, checking its existing
  review and original Creator/reviewer inequality before candidate status/pin changes.
  Never rewrite the version or add approval evidence. This operation-time bookkeeping
  is not bulk historical backfill. Unbound prior approval survives replacement; all new
  submissions/approvals require binding. Once a replacement is approved there is no
  fallback to an older approval.
- Without exact independent approved review, including self-review-only evidence:
  preserve the old approved status and exact submitted pin as a clearly marked historical
  compatibility authority. Do not set the evidence-backed pointer, invent reviewer/time,
  insert a synthetic approved review or treat status as proof of independent approval.
  Block replacement save before any candidate mutation, with
  template_approval_evidence_required, until a separately reviewed remediation policy exists.
  This preserves prior authority while avoiding loss of its only pin. Explicit Admin
  suspension remains allowed against that resolvable historical pin: write only suspension
  audit fields, keep pointer null and status/pin unchanged. A protective suspension is
  not approval evidence. No future Organizer activation is inferred.

A missing/unresolvable historical pin is an integrity exception for explicit inspection,
not permission to choose latest/MAX(version). Keep records unchanged and block mutating
authority operations until resolved. No automatic repair, backfill or withdrawal.
Before implementation, inventory such cases read-only; no production inventory was
performed for this documentation. Missing Locality and missing review evidence are
different problems and must not be conflated.

Universal publication/copy, legacy category-null resolution, Signal classification/content,
C4 lineage and all historical versions/reviews/Hunt snapshots remain unchanged.
New columns default to NULL, no existing pointers are bulk populated and no existing
approvals are automatically suspended. Classified Organizer gates remain closed.

## 6. Transactions and concurrency safeguards

Use one client/transaction. Lock Template first, read fresh state after waiting, then
Country → Locality shared locks for transition validation; recheck country membership
as in C6b-4. Catalog writers use Country → Locality and never acquire Template locks.
Hold locks through commit, with no network calls inside.

Serialize append, submit, approve, request-changes and suspension on the identity.
All Local decisions require the exact inspected candidate version; suspension requires
the exact approved authority version. Two review decisions cannot both succeed.
Approve versus suspension either preserves suspension then updates pointer, or makes
an old expected authority fail; no lost suspension. Saving a replacement cannot erase
the old pointer or an evidence-less compatibility pin. Reader joins must return a
coherent exact version, content/pair and suspension state.

Deferred pointer checks must allow the evidence-backed compatibility capture even when
the transaction ends in draft, but only when the pre-operation authority was the same
approved submitted version with an existing independent review. They must not permit
arbitrary old-review lookup, self-evidence or a newly invented compatibility approval.
Normal new approval requires the exact current submitted candidate and review.
Database guards protect pointer retention/category/FK/evidence and suspension tuple
all-or-none/immutability, including direct SQL attempts.

Candidate/pointer/review/audit changes commit together or all roll back, including
deferred commit failure. Existing one-decision-per-version and immutable classified
review constraints remain intact. Lost-response retries reload or receive conflict;
no idempotency store or new event machinery. Preserve pooled-client cleanup.

## 7. Required PostgreSQL acceptance tests for later implementation

These are future requirements, not executed results. Use disposable PostgreSQL with
TEST_DATABASE_URL enabled, real model/HTTP paths and separate concurrent connections.

- Upgrade/rerun versus fresh-schema parity; null defaults, no pointer/evidence backfill
  or automatic suspension. Preserve historical version/review/Hunt fingerprints.
- SQL rejects cross-Template/wrong-category/unapproved/self-evidence pointer targets,
  clear/regression and arbitrary historical-review promotion. Exercise valid compatibility
  capture followed by draft in one transaction. Keep review primary/exact-decision keys,
  decision values, C4 source FKs and classified review immutability unchanged.
- Draft omission/inheritance/null remains supported; new unbound submissions and old
  unbound pending approvals fail. Proposal IDs cannot bind. Inactive/missing Locality,
  malformed pairs, wrong country and changed latitude or longitude fail without writes.
- Independently vary each material field (identity, countryCode, latitude, longitude)
  and active status. Descriptive-only changes to name, countryDisplayName and
  administrativeContext at submit or after submit remain approvable, retaining the exact
  original snapshot. Explicit same-ID refresh creates a new version only.
- Approved v1 → draft/submitted v2 → changes_requested v2 → draft/submitted v3 preserves
  v1 authority; independent approval of v3 switches atomically. Self-approval fails,
  request-changes reuses the existing decision/path and no rejection extension appears.
- Replacement Locality A → B preserves A through drafting/review/request-changes and
  switches only on B approval. Inactive/material drift after submission blocks approval
  but allows request-changes; descriptive drift does not. Old Hunts remain identical.
- Evidence-backed unbound compatibility authority survives lazy capture/replacement.
  Evidence-less and self-evidence historical approvals keep status/pin, block revision
  without writes, remain inspectable and permit explicit suspension without synthetic
  reviews/pointer population. Missing pin fails explicitly, never falls back to latest.
- Suspension records exact version/actor/reason/server time atomically; stale version,
  duplicate suspension, unauthorized actors and partial tuples fail. Tuple cannot be
  cleared/overwritten. New approval and registry reactivation retain suspension; no
  reinstatement endpoint/reset. Suspended draft deletion and hard deletion of retained
  audit actors are prevented through existing controlled-deletion rules.
- Concurrent save/submit, two approvals, approve/request-changes, approve/suspend and
  duplicate suspend yield serialized outcomes with no duplicate reviews or lost authority.
  Transition versus catalog rename/country/coordinate/deactivation races yields coherent
  checks and saved artifacts; test both lock acquisition orders.
- Inject review/authority/audit write and deferred commit failures: complete rollback,
  unchanged prior authority/suspension, reusable pooled clients. Retain capability
  revocation, guest/blocked/retired denial and other-owner nondisclosure coverage.
- Universal C5 publication/revision/copy and legacy/Signal/catalog/geography/direct Hunt
  behavior pass unchanged. Both classified categories remain closed to Organizer selection;
  historical Hunt snapshots remain byte-equivalent throughout all transitions.
- Report focused/full PostgreSQL results and required typecheck/build/diff checks in the
  implementation PR. Do not claim deployed, provider-entitlement or E2E evidence.

## 8. Unresolved decisions and deferred scope

Review must confirm the precise material field policy: stable UUID/country code and
numeric representative coordinates; descriptive labels do not force resubmission.
There is no tolerance threshold or canonical subdivision model in this proposal.

Reinstatement and repeat suspension cycles are deferred. Before enabling suspension
operationally, accept this one-way boundary or separately approve the minimum reversible
mechanism and retained audit history. No reset is implicitly authorized here.

Read-only inventory must establish historical exact-review/pin coverage before approved
Local revision rollout. Evidence-less approvals remain compatible and explicitly
suspendable; their revision/remediation path is unresolved and must not fabricate history.
Confirm operation-time capture guards and final additive field/API names during review.
The unrelated proposal-only account-deletion concern remains separate; the new audit
actor dependency must nevertheless be handled safely by any later implementation.

Deferred G4/C7/D10: classified Organizer Country → Locality selection/resolver,
unbound/historical compatibility activation, route fit/evidence/safety/validity/expiry,
effects of suspension/inactive places on future Hunt publish/start, FE and Participant
runtime. Later selection must consume exact approval authority plus suspension, not
candidate status. “Eligible” here describes approval continuity, not complete rollout.

No Mapbox persistence, historical backfill, automatic withdrawal, new Template category,
workflow engine or source propagation. Preserve Universal, legacy, Signal and saved Hunts.
This contract supersedes C6a §7/U2's temporary-withdrawal proposal for this slice.
Revise Draft PR #86 in place; documentation only. Stop for ChatGPT re-review without
application code, migrations, merge or deployment.
