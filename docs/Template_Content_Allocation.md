# Approved Content allocation to Hunt Templates (C2e-01)

## Persistence boundary

The existing `HuntTemplates.createCreatorDraft` and `createCreatorVersion` operations insert complete, immutable `hunt_template_versions.content` artifacts, even while the Template identity is a draft. There is no later mutable version finalization operation. Allocation therefore resolves during that existing save, after ownership/lifecycle checks and locality binding, before canonical exercise instance allocation and the version INSERT. Submission and independent Template approval keep their existing behavior and pin the already frozen version. No new endpoint or Template model is introduced.

One SQL statement captures exact revision payloads, matching immutable approval evidence, latest approved versions for Random, and the canonical locality-to-GeoNames hierarchy. All assignments use that statement's PostgreSQL visibility. Content approvals are monotonic and approved revisions/events are immutable; new drafts and concurrent approvals cannot change returned payloads. The Template identity lock serializes version creation. Resolution, canonical instance generation and version creation share the existing transaction; failure rolls back the identity/version/lifecycle changes. Local bindings with a selected locality are revalidated and share-locked during allocation, including inherited bindings.

## FE integration contract

Use existing authenticated Creator routes:

- `POST /api/creator/templates` with `{key, category, content, localityId?}`.
- `POST /api/creator/templates/:key/versions` with `{content, localityId?}`.

Allocation opts in only when `content.checkpoints[].libraryAllocations` is present. Template classification must already be `universal` or `local`. `content.configuration.category` supplies the academic category (`Mathematics`, `History`, `Science`, `Mixed`), separate from the immutable Template classification. Existing optional `curriculum` and `grade` selectors remain authoritative. Do not create Main/Unit/Lesson identifiers.

Choose Specific sends the exact IDs returned by approved discovery/detail:

```json
{
  "checkpoint": 1,
  "role": "normal",
  "libraryAllocations": {
    "personal": {
      "mode": "specific",
      "contentId": "11111111-1111-4111-8111-111111111111",
      "revisionId": "22222222-2222-4222-8222-222222222222"
    }
  }
}
```

Random sends no IDs. Optional filters use existing Content discovery identifiers and narrow the authoritative Template context:

```json
{
  "role": "terminal",
  "libraryAllocations": {
    "personal": {"mode": "random", "filters": {"type": "single-choice"}},
    "team": {"mode": "random", "filters": {"type": "shared-final-key"}}
  }
}
```

FinishPoint is the existing unnumbered `role: terminal` checkpoint entry and supports the same Personal and Team allocations. No FinishPoint-specific allocation operation exists. Optional Random filters are `classification`, `type`, `category`, and `grade` (5–12 or `unspecified`). Classification must match the slot. Category and any specific Template grade cannot be overridden. Arbitrary geography filters are rejected: location comes from the Template's persisted locality and canonical geographic catalog. Text search and pagination are browsing controls, not allocation eligibility constraints.

The saved response replaces each selection with `{mode,contentId,revisionId,version,classification,type,filters?}`. `version` is the **approved Content revision version**, distinct from `content.version`. The exact complete exercise is frozen in the existing `checkpoint.customExercises.personal/team` representation, with fresh instance `id` and `{templateKey,version}` owner. Mechanic, schema version, answers, interaction, hints, feedback, solution, Unicode, LaTeX and whitespace remain exact. Checkpoint containment binds the source and payload to the assignment; there are no gameplay-time Library references.

For ordinary edits or radius changes, echo the entire saved allocation and canonical exercise unchanged at the same checkpoint/slot. A saved Random pin is retained, including across a new Template version; GETs, submission, approval, Universal copies and Hunt snapshots never reroll it. New versions allocate fresh Template-owned instance IDs while preserving source identity/payload. To intentionally select again, remove that slot's frozen `customExercises` entry and send a new Specific selection or an unresolved Random request. Changing the payload while retaining its allocation is rejected. Supply neither `id` nor `owner` for a new Library selection. Create Your Own remains the existing canonical exercise authoring contract and creates no Library record. Explicitly removing Library provenance when authoring a new version makes that new instance Template-owned; historical provenance is untouched.

Specific never substitutes revisions: a superseded **approved** revision remains valid after newer drafts or approvals. Random selects the latest approval-backed revision per Content identity **before filtering**, matching C2d discovery. It never falls back to an older matching revision when the latest approved one is ineligible. No seed or new Creator mode is exposed.

Personal uniqueness is by **Content ID**, across all checkpoints including FinishPoint, even when different approved revisions are requested. Specific pins reserve identities before Random. A randomized augmenting-path matching resolves overlapping Random pools without greedy false shortages. Team allocations do not inherit Personal-only uniqueness. Allocation adds no global requirement that legacy or unfinished checkpoints contain challenges.

## Eligibility decisions and limits

| Context | Policy |
| --- | --- |
| Universal Template or unbound locality | Universal exercises only. |
| Locality with known country but no canonical city mapping | Universal plus that Country only; never infer Region/City from labels or coordinates. |
| Mapped Locality | Universal, its Country, its catalog-resolved Region, and its exact GeoNames City. |
| Unknown/unresolved catalog Region | No Region-scoped exercise; exact known City remains eligible, as in C2d. |
| Academic category | Exact `configuration.category` equality. `Mixed` means Content categorized Mixed; cross-category inclusion has no established policy. |
| Specific Template grade | Explicit identical Content grade; unspecified does not match. |
| Omitted/mixed Template grade | No grade restriction, matching discovery without a grade filter. A Random grade filter can narrow it. |
| Math curriculum | Requires Mathematics category. Content subject metadata remains optional under C2c/C2d; no new curriculum identifiers or mandatory subject are invented. |

Template authoring supports grades 9–12 (and mixed), whereas Content supports 5–12. This change preserves those existing contracts. Random on a mixed-grade Template may narrow to a supported Content grade; selecting a specific Template grade outside 9–12 remains an existing authoring validation failure. Missing academic category on an allocation request fails actionably rather than guessing a category. Other saves retain their legacy behavior.

The read-only FE review used `Tedix_Hunt_FE/main`: `ChallengeAllocation.tsx`, `ContentSelection.tsx`, and `services/api/creatorTemplates.ts`. Current allocation choices are session-only and have no assignment callback or serialized allocation fields; that remains an unresolved FE integration gap. The FE's alternate-location browsing must not override the saved Template's eligibility context. No FE files changed. Publication/gameplay notices and the existing custom exercise delivery gate remain in place: this PR freezes content but does not enable participant delivery, mechanics or scoring.

## Validation failures

Existing JSON error convention: `{error, details:[{path,message}]}`, HTTP 400 for allocation validation; existing 401/403/404/409 authorization, ownership and lifecycle responses remain unchanged.

| Error | Action |
| --- | --- |
| `incorrect_revision_identity` | Refresh exact detail and send a matching Content/Revision pair and metadata. |
| `unapproved_revision` | Select a revision with matching Approved status and immutable approval evidence. |
| `allocation_classification_mismatch` | Select a Personal/Team exercise matching the slot. |
| `allocation_geography_mismatch` | Select content applicable to the persisted Template location. |
| `allocation_category_mismatch`, `allocation_grade_mismatch` | Align selection with authoritative Template learning context. |
| `empty_random_pool` | Broaden supported filters or approve eligible content. |
| `duplicate_personal_exercise` | Use a different Content identity at the other checkpoint. |
| `insufficient_distinct_exercises` | Add eligible distinct Content identities or broaden overlapping pools. |
| `invalid_checkpoint_assignment` | Use valid unique checkpoint numbers or the existing unnumbered FinishPoint. |
| `allocation_slot_conflict`, `allocated_payload_mismatch` | Remove the conflicting owned exercise or retain the frozen Library payload unchanged. |
| `allocation_requires_classified_template`, `allocation_category_required` | Use a classified Template and supply its academic category. |
| `invalid_allocation`, `invalid_allocation_filters`, `allocation_mechanic_mismatch`, `unsupported_content_revision` | Use the documented identifiers, shape and canonical supported payload. |

## Storage and compatibility

Migration `045_template_content_allocation` adds a focused INSERT/UPDATE guard to the existing version table. It requires exact approved identity/version/classification/type and exact canonical frozen payload, and rejects duplicate Personal Content identity even through direct SQL. Existing custom exercise guards enforce Template ownership, instance identity and immutability. No rows are rewritten, no legacy exercises reinterpreted, and no Content discovery/approval semantics changed. Fresh schema and upgrades contain the same guard. Copying a published Universal preserves frozen source provenance while the existing copy path reassigns destination instance ownership. Existing Hunts remain unchanged.

## Verification

All database checks used a disposable local PostgreSQL 17 container and the dedicated `tedix_test` connection. Each integration suite creates and drops its own test database. No persistent application database was used.

- Final full backend suite: **84 files, 1,838 tests passed**, no skips; includes **49 allocation integration tests** and the existing Template, Hunt, Content approval/discovery, geographic catalog and migration regressions.
- Additional focused allocation, fresh-schema parity and OpenAPI regression run: **57 tests passed** before the final full run.
- Typecheck and production build: passed.
- Migrations: upgrade through 045, repeat-run safety, preserved C2a rows, and fresh-schema function/trigger parity passed.
- `node docs/validate-template-content-allocation.mjs`: passed; validates OpenAPI syntax/references and accepted/rejected Specific/Random examples.
- Full-document OpenAPI validation: **355 pre-existing diagnostics**, byte-for-byte identical to untouched starting `main` (`92970d6`); **zero new diagnostics**. Existing unrelated diagnostics were not hidden or changed.
- `git diff --check`: passed.

The first full run identified the migration regression's exact expected list ending at 044. That assertion now includes 045 and the parity checks additionally inspect the new function and trigger. Existing assertions remain intact. Final verification passed after the unresolved Random source-metadata ambiguity was closed in both runtime validation and OpenAPI.

STOP for ChatGPT review. Do not merge or deploy.
