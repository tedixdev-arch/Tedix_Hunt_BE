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

## 2. Decision: candidate lifecycle and exact approval are separate

Add a narrowly scoped `local_approved_version` on the Template identity.
Reuse existing version creation, submission, review evidence and identity-lock
patterns. Do not widen `published_version`, its trigger or PublishedUniversals.
This avoids changing Universal reuse/publication semantics and makes Local authority
explicit without another publication table or release step.

The pointer identifies the most recently independently approved Local version,
including its immutable Locality pair. It is retained during suspension; “approved”
and “currently eligible” must not be conflated. For a managed Local:

`eligible exact version = local_approved_version, unless local_eligibility_suspended`.

Candidate `status`, latest version and `submitted_version` never replace that
authority. No MAX(version), most-recent-review lookup or live-catalog reconstruction
may choose the eligible artifact. Current Locality activity is checked at transition
time, not used as an automatic withdrawal filter for an existing approval.
Other later eligibility/safety rules remain deferred.

| Candidate transition | Candidate status/pin | Prior Local authority |
| --- | --- | --- |
| First draft / append draft | draft; no submitted pin | Absent, or unchanged prior approval |
| Submit latest complete bound version | submitted; exact requested version | Unchanged |
| Independent approve exact candidate | approved; retain reviewed pin | Atomically replace pointer with candidate |
| Request changes / reject candidate | changes_requested; retain reviewed pin | Unchanged |
| Owner saves correction/replacement | draft; clear submitted pin | Unchanged |
| Admin suspends / reinstates | Candidate status/pin unchanged | Retain pointer; toggle suspension |

“Rejected” is a review outcome, not a new lifecycle enum: add a Local-only
`rejected` decision, use `changes_requested` as the editable nonapproved candidate
state. A rejected version is terminal and cannot be resubmitted unchanged; Creator
must append a new version. No permanent Template ban is implied.
An initial rejected/requested-changes candidate has no eligible version.

Suspension is an orthogonal eligibility state, never a candidate status. Draft,
submitted, changes-requested and approved candidates can coexist with suspension.
Approval while suspended updates the approved pointer but does not lift suspension.
Only explicit reinstatement can restore eligibility.

## 3. Minimum proposed schema and API changes

One additive forward migration with matching fresh schema; leave old migrations intact.

| Change | Required integrity |
| --- | --- |
| Nullable `hunt_templates.local_approved_version INTEGER` | Composite FK (id, version) to this Template's version, ON DELETE RESTRICT. Non-null only for Creator Local; explicitly handle SQL NULL category. |
| `local_eligibility_suspended BOOLEAN NOT NULL DEFAULT false` | True only for Creator Local with an exact retained approval authority. False on Universal/legacy. |
| Deferred Local approval-evidence guard | New/changed pointer must match the exact submitted candidate, final approved status and independent approved review in the same transaction. Never clear an established pointer or move it backwards. Preserve it across authoring and decisions. |
| Existing review decision constraint | Permit Local-only rejected outcome; retain existing approved/changes_requested behavior and exact-decision uniqueness. Do not relax source-review FK/uniqueness used by C4 provenance. |
| Small `local_template_eligibility_events` audit table | Append-only id, template_id, approved_version, action (suspended/reinstated), Admin actor, nonblank bounded reason, timestamp; exact composite version FK and restrictive actor FK. Repeated suspension cycles require separate rows. No content or Locality copies. |

The event table is only for repeated explicit suspension/reinstatement evidence.
Using review decisions for these events would conflict with the existing unique
(template, version, decision) review key and its source-provenance dependencies.
Do not introduce a workflow engine or general event framework.
For every suspension flag change, require the corresponding exact-version event
in the same transaction, enforced at the database boundary; events cannot be
updated/deleted. A repeated identical command returns a conflict, not a second event.
Audit-table user references must be included in controlled-deletion dependency
handling so actors with retained events are retired rather than hard-deleted.

Extend approved Local owner saves through the existing
`POST /api/creator/templates/{key}/versions`; preserve its complete-content,
Locality inheritance/refresh/null and version-allocation contracts.
Existing submit body remains `{"version":2}`.
Existing Admin approve/request-changes paths retain `{"version":2}`.
Add Local-only `POST /api/admin/templates/review/{key}/reject` with
`{"version":2,"reason":"Route needs correction"}`.
The bounded rejection reason must be retained with the review (nullable additive
reason column for existing decisions; required for new rejection).

Add narrowly scoped `POST /api/admin/templates/{key}/suspend` and `/reinstate`,
each with `{"version":1,"reason":"Explicit eligibility decision"}`, where version
means the retained approved authority, not the candidate. No client actor/status,
pointer, timestamp or snapshot inputs. Add approved reference and suspension state
to existing owner/Admin representations, clearly separate from candidate content;
Admin needs a private exact approved-artifact read for this action, e.g.
`GET /api/admin/templates/{key}/approved`. It returns saved content/pair plus
current catalog context separately, even while suspended or unbound. No public catalog.

Preserve authentication/capability checks and missing/other-owner nondisclosure.
Use persisted active non-guest Creator for authoring and authoritative Admin for
review/eligibility actions. Self-approval remains forbidden; proposed reinstatement
also forbids the Template Creator because it restores eligibility. Self-request-changes,
rejection and protective suspension may remain allowed; they grant no approval.

Use existing `{"error":"code"}` envelope and lifecycle errors:
400 invalid_input for malformed bodies; 400 locality_required for missing Local pair
at submit; 409 locality_unavailable for inactive/missing current registry record;
409 locality_snapshot_changed for catalog mismatch; existing stale submit errors and
409 template_not_reviewable for stale/missing classified decision version;
403 template_self_approval_forbidden for approval/reinstatement by Creator.
Suspension/reinstatement absent authority, stale approved version or already-target
state → 409 template_eligibility_conflict. Unknown/platform keys → existing 404.
These new actions reject Universal/unclassified identities without altering them.

## 4. Submission and independent review rules

1. Authorize, lock Template, enforce lifecycle and requested latest version, and
   retain all existing gameplay/geographic completeness validation.
2. Every new Local submission requires a valid stored FK/snapshot pair. Pending or
   rejected proposal IDs and route geography strings cannot substitute.
3. Lock Country then Locality, re-read membership and active status, and compare
   saved public snapshot facts with the current catalog. Require exact equality of
   all seven C6b-4 fields. This conservative rule avoids an unimplemented “material
   difference” classifier: even a display-name correction requires explicit same-ID
   refresh in a new version. Never refresh a submitted artifact in place.
4. Submission and approval both perform these checks under locks held through commit.
   Admin reviews immutable content and snapshot; current catalog facts/activity are
   displayed separately. Approval repeats full exact-candidate validation rather than
   trusting that submission checks previously passed.
5. If Locality becomes inactive after submission, approval returns locality_unavailable,
   with no review/pointer/status write. Candidate stays submitted until Admin requests
   changes/rejects, or the same identity is legitimately reactivated. If facts changed,
   approval fails locality_snapshot_changed; request changes and save a refreshed version.
   Rejection/request-changes must remain possible for inactive/unbound candidates.
6. Independent approval writes exact approved review, candidate status and Local pointer
   atomically. No Creator may approve their own Template, including an Admin with a Creator
   role. Client-provided reviewer identities are never trusted.
7. Rejection/request-changes record the exact inspected pin and leave prior approval and
   suspension untouched. Existing pending unbound submissions cannot be grandfathered
   into new approval: request changes, append a bound version, resubmit.
8. A replacement may explicitly change Locality A to B. Review B with the complete new
   content; approval transfers authority from exact A version to exact B version atomically.
   A remains authoritative before commit, including throughout draft/rejection. No
   locality change propagates to previous versions or saved Hunts. Ordinary inheritance
   of an inactive or stale A remains allowed only for drafts.

Catalog deactivation/correction alone never clears an approved pointer or changes
suspension. An Admin who intends withdrawal must explicitly suspend. This makes
continuity observable and avoids silently destroying an existing approval.

## 5. Explicit suspension, reinstatement and compatibility

Suspend requires an exact existing approval authority and expected approved version.
Under the Template lock, preserve that version, set suspension and append reason/actor
event together. Candidate editing/review may continue. All prior approved reviews,
version rows and Hunt snapshots remain intact.

Reinstate requires currently suspended state, current approved-version match and an
independent Admin. It restores the retained pointer only; it cannot select an arbitrary
older approval or approve an unreviewed candidate. For a bound authority, recheck active
Locality and exact snapshot equality under catalog locks. If unavailable/stale, keep
suspended: refresh through a new version, submit and approve, then explicitly reinstate.
Reactivation alone never reinstates. An approval that races reinstatement makes a stale
expected version fail; it must not restore a different artifact unnoticed.

**Existing approved unbound Locals:** no historical data backfill, automatic binding,
withdrawal or invented approval evidence. At rollout keep their exact existing
status=approved/submitted_version authority as an explicit compatibility fallback while
local_approved_version is null. Preserve that authority and mark it unbound in private
reads; it is not permission to open classified selection. Never fall back to latest.
Invalid/missing pins remain an explicit integrity conflict; do not silently pick a version.

Before the first replacement save or suspension for a compatibility approval, capture
that same exact prior version into local_approved_version in the same locked transaction,
only if its independent approved review exists. This is lazy authority bookkeeping on
an explicit operation, not a bulk historical backfill or version/snapshot mutation.
Then proceed without losing prior eligibility. The Locality gate applies to the new
submission, not to retaining the old unbound approval.
Evidence-less historical status must remain readable and unchanged, be reported for
explicit review, and block revision/suspension transition until its authority is resolved;
do not fabricate a review or silently withdraw it. This exception must be surfaced
before implementation if such records exist.

A previously unbound authority explicitly suspended under this compatibility path may
be reinstated to that same exact independently approved unbound version without inventing
a binding. Preserve the compatibility marker. Once a bound replacement is approved,
there is no fallback/rollback to the former unbound version. New approvals always require
binding. No new “legacy Template category” or historical classification is introduced.

Universal publication/read/copy, category-null legacy resolution, Signal and source
provenance remain unchanged. New fields default to null/false; no bulk pointer population.
Deletion must reject retained approval/event dependencies even when candidate status is
draft/changes_requested. Already saved Hunt snapshots remain unchanged in every transition.

## 6. Transactions and concurrency safeguards

Use one pooled client/transaction per transition. Lock Template identity first; after
waiting, read current candidate/approval state in a fresh statement. Then acquire Country
→ Locality shared locks for validation, using C6b-4's country-membership recheck.
Catalog writers use Country → Locality and never acquire Template locks. No external
network work occurs inside these transactions.

Identity lock serializes saves, submission, competing review decisions and suspension
actions across app instances. Require exact expected candidate version for all Local
decisions and exact approved version for suspension actions. A second approve/reject/
request-changes loses with the current not-reviewable conflict; no duplicate decision,
pointer regression or mixed snapshot. Candidate approval must preserve a concurrent
suspension's resulting flag; authoring cannot reset it.

Deferred integrity checks must examine committed final state and evidence, including the
narrow compatibility capture exception; normal pointer changes still require new exact
approval. Pointer/history protection must reject direct SQL clear, cross-Template version,
wrong category, self-review evidence, unapproved target and backward movement.
Suspension events must match the authority at the serialized operation; later approval
does not rewrite an older event's version.

Status/pins/review/reason/event writes commit together. Failure after any write, including
deferred constraint/commit failure, rolls everything back and releases the pooled client.
A lost-response retry reloads current state or gets conflict; no idempotency store is needed.
Read approval reference/content/pair/state coherently from one exact join/snapshot.

## 7. Required PostgreSQL acceptance tests for later implementation

Use disposable PostgreSQL, real model/HTTP paths, separate concurrent connections and
TEST_DATABASE_URL enabled; no skipped integration suites. These are requirements, not
executed results.

- Fresh schema versus additive upgrade/rerun parity. Snapshot fingerprints of old versions,
  reviews, Locality JSON, Universal publication/source provenance, Signal and Hunts remain
  identical. Defaults do not populate pointers or withdraw existing approvals.
- SQL rejects wrong-category/half authority, missing/cross-Template/unapproved/self-approved
  targets, pointer clear/regression, immutable event/review edits and deletion dependencies.
  Existing C4 review-key FKs remain valid. Controlled deletion retains audit actors.
- Unbound drafts save, but new submission fails locality_required. Pending/rejected proposal,
  inactive catalog, malformed input and stale candidate fail without partial writes. Accepted
  manual locality must be explicitly saved; no proposal-to-Template side effect.
- Exact inherited snapshot versus catalog correction/name change; submit/approve mismatch
  fails. Explicit same-ID refresh appends a version. Inactive after submit blocks approval,
  leaves prior authority intact, and still permits exact request-changes/rejection.
- First independent Local approval sets pointer; combined-role self-approval fails. Full
  approved v1 → draft v2 → submitted v2 → rejected/requested-changes v2 → draft/submitted v3
  preserves v1; approval v3 replaces it atomically, with matching content and Locality pair.
- Locality A → B replacement: before commit A's exact version remains authoritative; after
  commit B's exact version is authoritative; rejection preserves A. Old Hunt snapshots never move.
- Compatibility unbound approved exact pin survives rollout and replacement; lazy capture
  preserves its original review/snapshot. New unbound approval fails. Evidence-less/corrupt
  compatibility records are visible conflicts, never auto-fixed. No fallback to MAX(version).
- Suspend/reinstate multiple cycles with reason/actor/version events; self-reinstatement,
  stale version, duplicate target state and no authority fail. Suspension survives draft,
  submission, rejection and new approval. Inactive/stale bound reinstatement stays suspended;
  explicit compatible unbound reinstatement does not manufacture a binding.
- Separate-connection races: save/submit, two approve decisions, approve/request-changes/reject,
  approve/suspend/reinstate, and submit/approve versus catalog correction/deactivation/country
  rename. Assert serialized before-or-after outcomes, one winning transition, no lost suspension,
  duplicate events, deadlock or partial authority.
- Inject review/event insertion and deferred commit failures; verify rollback of candidate,
  pointer, suspension and audit writes and reusable connections. Unauthorized, guest, blocked,
  retired/revoked capabilities and other-owner nondisclosure remain enforced.
- Universal C5 continuity/copy and legacy catalog/geography/direct Hunt selection regressions
  pass unchanged. Both classified categories remain excluded from Organizer routes. Historical
  Hunts remain byte-equivalent through revision, Locality correction and suspension.
- Report focused/full PostgreSQL regression results, typecheck/build and diff checks in the
  implementation PR; do not substitute source inspection for executed results.

## 8. Deferred scope and decisions for review

This contract resolves the proposed representation, continuity, exact-review gates,
inactive-between-review handling, replacement Locality change, rejection mapping and
explicit suspension/reinstatement. ChatGPT review must confirm these choices before coding,
particularly conservative all-field snapshot equality and compatible unbound reinstatement.

Before implementation, establish whether any existing classified Local approval lacks an
exact independent review; resolve each exceptional authority explicitly without fabricated
history. Confirm the lazy capture exception and final schema/API naming during review.
No deployment data inventory was performed here. The plan's separate proposal-only
account-deletion concern remains separate, except new event dependencies must be handled.

Deferred G4/C7/D10: Organizer Country → Locality selection and shared eligible resolver,
compatibility activation/visibility of unbound records, route fit/evidence/safety/expiry,
future Hunt publish/start effects of inactive places or suspension, FE implementation,
Participant runtime and deployment verification. Later selection must consume this exact
approval authority and suspension state with server-created snapshots; candidate status
alone is insufficient. “Eligible” here is approval continuity, not full Organizer rollout.

No Mapbox persistence, provider licensing decision, automatic withdrawal, historical backfill,
new Template category, source propagation, generic workflow system or public catalog API.
This document supersedes C6a §7/U2's temporary-withdrawal proposal for this slice and
implements no policy by itself. Deliver one documentation-only Draft PR; stop for ChatGPT
review, without merge or deployment.
