# C7 — Organizer Local Template eligibility and selection contract

**Proposed for ChatGPT review, 28 October 2026. Documentation only.**
No implementation, route activation, migration, frontend change, merge or deployment
is authorized. This defines discovery and selection into a draft Hunt; it does not
certify route safety or authorize Participant runtime rollout.

## 1. Reviewed implementation and boundaries

Reviewed latest BE main `0b63014f0ea197598990e9b92755dc999375141a`
(merged #87), including:
[C6b-5 contract](F7_C6b_5_Local_Approval_Revision_Contract.md),
[implementation report](F7_C6b_5_Implementation_Report.md),
[C6b-4 binding](F7_C6b_4_Locality_Binding_Contract.md),
[C6a](F7_C6a_Hybrid_Locality_Contract.md),
[Template model](../src/models/HuntTemplate.ts),
[migration 027](../src/db/migrations/027_local_template_approval.ts),
[fresh schema](../src/db/schema.sql),
[Admin suspension](../src/routes/adminTemplateEligibility.ts),
[Admin review](../src/routes/adminTemplateReviews.ts),
[legacy catalog](../src/routes/huntTemplates.ts),
[catalog domain](../src/domain/huntTemplates.ts),
[Hunt routes](../src/routes/hunts.ts), [Hunt model](../src/models/Hunt.ts),
[geography routes](../src/routes/geography.ts),
[geography model](../src/models/Geography.ts) and
[authorization](../src/middleware/auth.ts).

Also reviewed [FE Master Implementation Control Plan v3](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/53a3e376025adb161e28430a4d6c8ebe35644218/docs/TedixHunt_Master_Implementation_Control_Plan_v3.md),
especially §§5, 8–9. Its C6b-4/5 progress statements predate merged BE #85/#87;
current code governs implemented facts. Its continuity policy and G0–G6 rollout
gates remain binding. This document does not claim full F7/G4/D10 completion.

Current facts, inspected in implementation rather than inferred from the plans:

- Creator Local versions are complete immutable classified rows with an optional
  paired locality FK/snapshot. The snapshot contains ID, country code/display name,
  locality name, administrative context and representative coordinates; no active
  flag or private provenance. Omission inherits the exact pair; explicit selection
  captures stored catalog facts into a new version.
- `local_approved_version` is separate from candidate status and submitted pin.
  Independent approval moves it atomically with the exact review. Drafting,
  submission and request-changes preserve it. Locality A → B changes authority only
  when the B replacement is approved.
- Null-pointer historical approved identities resolve their submitted pin as
  compatibility authority. Exact independent evidence permits capture before first
  replacement save; evidence-less/self-review-only history cannot be revised.
  Unresolved pins are integrity exceptions. No automatic historical backfill exists.
- Suspension stores an immutable actor/time/reason/authority-version tuple.
  Presence of `local_suspended_at` blocks eligibility, even if a later approval
  moves the pointer. No reinstatement exists. Historical reviewers need not retain
  active Admin capability forever; current reviewer retirement does not revoke evidence.
- Submission/approval validate binding, active Locality, country membership and
  numeric coordinates under Template → Country → Locality locks. Descriptive
  label drift is allowed without rewriting saved artifacts. Country has no active flag.
- Stored geography exposes countries, active text search (required country and
  nonempty query, maximum 50 results), and ID lookup including inactive rows.
  Initial Country reference is RO; no seeded Localities or provider dependency is implied.
- Legacy approved catalog/geography/direct selection explicitly require
  `category IS NULL`. Creator legacy approval uses submitted_version; platform
  legacy approval uses its latest saved version. Classified Local and Universal
  routes are not Organizer catalogs.
- `POST /api/hunts` creates an empty draft plus Hunt-specific organizer role,
  checking Creator/Organizer capability and organization owner/member access.
  `PATCH /api/hunts/{id}` requires Hunt-specific organizer authority and draft state.
  It accepts legacy templateKey, resolves server content/version and stores
  template_key/template_version/template_snapshot. Resolution and update are
  separate operations today: this is insufficient for the new concurrency contract.
  Existing creation does not accept an authoritative client snapshot.
- General setup strings, schedule, capacity, contact and pilot options are separate
  Hunt settings. Existing saved snapshots feed readiness/participant behavior;
  they must not be regenerated from the live Template.

Inspected assertions in localTemplateApproval.integration.test.ts,
localTemplateAuthorityGuards.integration.test.ts, templateLocalityBinding.integration.test.ts,
templatePublication.integration.test.ts, geography.integration.test.ts and
routes/huntTemplates.integration.test.ts. The implementation report's 1,166 passing
tests are historical reported evidence, not tests executed for C7. No application
or PostgreSQL tests were run for this documentation change.

## 2. One resolver, exact immutable authority

Use one backend eligibility predicate for list, details and selection writes.
It returns exactly (templateId, key, version, content, localityId, localitySnapshot),
or no eligible artifact. No client snapshot, latest row, MAX(version), candidate
status, candidate locality, Universal publication or arbitrary approved-review search
may replace the exact authority.

Resolve authority in this order:

1. Require identity origin=creator, category=local and a Creator owner identity;
   require the resolved version's classification/owner identity to agree.
2. Use local_approved_version when present. Only when absent and status=approved
   may submitted_version resolve the documented historical compatibility authority.
   Missing/unresolvable authority fails closed; do not fall back if an established
   pointer is invalid.
3. Require the exact version's approved review and reviewer != original Creator,
   using existing retained independent approval evidence/guards. Do not require
   the historical reviewer or Creator to have today's active capability.
4. Require no suspension tuple, a valid bound saved pair, and the current catalog
   checks below. Read-only resolution never captures a pointer or changes history.

For operational selection, the version's localityId must equal snapshot.id and the
existing current Locality UUID. Snapshot countryCode must equal current membership
and selected Country. Require the Country row and active=true on current Locality.
Require valid saved snapshot shape and finite bounded numeric coordinates equal
to the current catalog coordinates, as in C6b-5. Material country/coordinate drift
excludes new selection; descriptive name/countryDisplayName/administrativeContext
drift alone does not. Return saved facts with the artifact and current display facts
separately. No inference from Hunt strings, route points or proposal IDs.

This material-drift gate is a proposed C7 operational rule, not withdrawal of approval.
The approved version remains inspectable by its owner/Admin. New independent
replacement approval can supply a refreshed binding. Registry reactivation restores
operational eligibility only if every predicate holds and no suspension exists.

| Identity / authority state | New selection | Retained authority |
| --- | --- | --- |
| Creator Local, exact independently approved pointer, valid current active binding | Yes, pointer version only | Unchanged |
| Same, replacement draft/submitted/changes_requested, including replacement bound elsewhere | Yes, previous approved version and previous locality | Unchanged until replacement approval |
| First draft/submitted/changes_requested without prior authority | No | None |
| Replacement approved | New pointer only; old displayed selection is stale | Prior reviews remain history |
| Any explicit suspension, even followed by approval/reactivation | No | Pointer/pin and suspension audit retained |
| Null pointer, historical approved pin, independent evidence and valid active material-matching binding | Yes, exact historical pin; no read-side capture | Historical compatibility authority |
| Historical unbound pin, with or without independent evidence | No | Preserved; no automatic binding/backfill |
| Historical bound pin without independent evidence, including self-review | No | Preserved; no synthetic evidence |
| Missing pin/version, malformed pair or inconsistent identity | No | Integrity exception; no repair or latest fallback |
| Inactive/missing Locality or material catalog drift | No | Approval retained; operationally unavailable |
| Universal, platform or category-null identity | No through C7 | Existing independent paths unchanged |

Approval continuity is therefore distinct from operational selection eligibility.
Historical bound and independently evidenced compatibility approvals need no artificial
reapproval; unbound/evidence-less records require separately authorized remediation
or a valid newly reviewed replacement where existing revision rules permit it.

## 3. Minimal read-only API proposals

All paths below are proposed contracts, not active routes. New C7 reads require
active non-guest authoritative Organizer capability; Admin/Creator alone does not
grant this capability. Authenticate/authorize before artifact lookup. Multi-role
Organizers qualify. Private Creator/Admin inspection remains separate.

Reuse existing geography reads without changing their semantics:

| Operation | Contract |
| --- | --- |
| Available stored Countries | GET /api/geography/countries → existing {countries:[{code,displayName}]}. These are supported registry countries, not a promise of eligible inventory; an empty Local catalog is valid. |
| Available stored Localities within Country | GET /api/geography/localities?countryCode=RO&q=Cluj → existing {localities:[public catalog fields],providerStatus:"not_requested"}. Active stored search, required query and existing 50-result cap remain. Country must be supported. |
| Current selected Locality context | GET /api/geography/localities/{id} → existing catalog object including active. Inactive lookup remains possible but confers no selection right. |

Geography endpoints retain their existing Creator/Organizer/Admin authorization.
No no-query enumeration, eligibility count, provider call or new geography endpoint
is necessary. Search/select explicitly; do not select the first same-name result.

Add only these Organizer artifact reads:

- `GET /api/organizer/local-templates?countryCode=RO&localityId=<uuid>&limit=20&cursor=<opaque>`
  → 200 `{templates:[{templateId,key,version,displayName,theme,localityId,localitySnapshot}],nextCursor:null}`.
  Require countryCode and localityId; limit defaults to 20, range 1–50. Order by
  immutable key then templateId, using an opaque validated cursor scoped to the
  filters. Each row satisfies the full resolver. This is a live advisory list, not
  a reservation; inventory changes can require refresh. No total count is required.
- `GET /api/organizer/local-templates/{templateId}/versions/{version}?countryCode=RO&localityId=<uuid>`
  → 200 `{templateId,key,version,displayName,theme,localityId,localitySnapshot,configuration,currentLocality}`.
  Require the exact currently eligible authority and matching filters. Configuration
  is the existing allowlisted geographic projection (normalCheckpointCount,
  checkpointPositions and finishPoint, with nested point allowlists), from that
  exact row. This is the complete Organizer selection-detail representation;
  full gameplay content/answers are copied internally, never exposed here.
  currentLocality is separately allowlisted public registry context.

Unknown parameters, invalid UUID/version/country syntax/cursor/limit → 400
`invalid_input`; version is a positive PostgreSQL INTEGER. Unknown supported-format
Country → existing geography-style 400 invalid_input. Unknown Locality or country
mismatch → 404 not_found; known inactive Locality → 409 locality_unavailable.
Valid active Locality with no eligible Templates → 200 empty list.
Absent/ineligible/stale artifact details → indistinguishable 404 not_found, including
drafts, old versions, suspended and historical unbound/evidence-less artifacts.
Use existing authentication 401 and capability 403 conventions and {error:code} envelope.

Neither response exposes candidate metadata, review notes, approval actor, suspension
reason, Creator email, proposal evidence, provenance, provider identifiers or answers.
Do not offer arbitrary historical version retrieval through these routes.
Use private/no-store responses; cached discovery never authorizes a write.

## 4. Turning selection into a Hunt

Preserve the existing two-step creation flow: create the empty draft using
POST /api/hunts, then select the Local artifact. For C7, “Hunt creation from a
Template” completes at the atomic selection/snapshot write, not at empty-draft creation.
Failure leaves that draft and all existing settings unchanged.

Propose one explicit new operation:

`PUT /api/hunts/{id}/local-template`

Body (and only these fields):
`{"templateId":"<uuid>","version":1,"countryCode":"RO","localityId":"<uuid>"}`.

Require active non-guest Organizer capability plus that Hunt's organizer role and
draft state. Organization membership alone, Supervisor role, Creator-only capability
or ownership of the source Template does not grant Hunt write authority.
Retain organization authorization on initial creation. Template eligibility is shared
across Organizers, not scoped to the source Creator; authoring remains owner-scoped.

Server resolves exact authority and revalidates every predicate at write time.
Never silently substitute a newer approval. Persist the approved row's complete
content into existing template_snapshot without merging user input into it, plus
the exact key/version and a durable templateId reference. Persist its exact saved
localityId/localitySnapshot as sibling Hunt source metadata; do not add locality
fields to or rewrite the approved content JSON. These are proposed additive storage
requirements for later implementation, not a migration in this PR.

Return 200 with the existing authorized Hunt representation plus additive source
identity/locality metadata. Copy no current registry labels into immutable source
metadata. Preserve general setup, schedule/timezone, country/region/city strings,
capacity/contact, organization, roles, rewards/access and Organizer pilot settings.
Strings are presentation/setup data, never authoritative binding. Existing validated
settings remain subject to existing readiness rules; selection must not reset them.

The captured source content and Locality pair are immutable together. If a draft's
Organizer explicitly selects another artifact, replace the whole source tuple
atomically after fresh validation; never patch individual snapshot fields. Repeating
selection still requires current eligibility. No byte-identical replay guarantee or
new idempotency store. Published/active/paused/finished Hunts cannot be reselected.

| Change after discovery, before selection commits | Required result |
| --- | --- |
| Candidate saved/submitted/requested changes | Same approved version can succeed |
| Replacement approval wins first | 409 template_selection_stale; reload and explicitly choose new approval |
| Suspension wins first | 409 template_not_eligible; no Hunt write |
| Locality deactivation wins first | 409 locality_unavailable; no Hunt write |
| Material geography correction wins first | 409 locality_geography_changed; no Hunt write |
| Descriptive rename wins first | Selection may succeed; snapshot retains approved labels |
| Selection wins first | Exact old approved snapshot commits; later changes never rewrite it |

Malformed or forbidden snapshot/content/settings fields → 400 invalid_input.
Unknown Hunt → existing 404; other Hunt's non-organizer → existing 403 before source
lookup. Non-draft → 409 invalid_hunt_state. After Hunt authorization, missing/wrong
category/no authority/no evidence/unbound/suspended source → generic
409 template_not_eligible. Return template_selection_stale only when a valid
otherwise eligible identity has a different current authority; do not reveal candidates.
Country/locality mismatch → 409 template_not_eligible. All failures leave the source
tuple and settings unchanged.

Suspension/inactivity/reapproval after commit does not rewrite or automatically
invalidate previously created Hunts, including drafts. Publish/start restrictions
for saved Hunts require separate G4/D10 policy review; no such new gate or Participant
behavior is implied here.

## 5. Transactions and concurrency

Discovery/details use a single coherent statement snapshot joining identity, exact
authority, evidence and current catalog; no mixed candidate/authority reads.
Selection uses one PostgreSQL client and transaction:

1. Validate persisted actor capability and Hunt role; lock the draft Hunt FOR UPDATE,
   then recheck state/authority after waiting. Protect relevant authorization rows
   against concurrent revocation through commit using the established account/role
   writer order, to be verified in implementation. Do not rely only on stale JWT claims.
2. Lock the selected Template identity FOR UPDATE and read fresh committed authority,
   suspension and exact immutable version/evidence after the wait.
3. Lock Country then Locality FOR SHARE, recheck membership after locking, validate
   active state/material facts and expected country/locality/version.
4. Write the entire source tuple to that draft Hunt and commit; all constraints,
   including deferred constraints, must succeed before responding.

The domain operation must receive this client; no pool-level query or second
transaction may perform resolution/update. Hold locks through commit; no network
calls inside. Template writers retain Template → Country → Locality order; catalog
writers retain Country → Locality and never acquire Template/Hunt. New selection
uses Hunt → Template → Country → Locality. No Template writer may later acquire
a Hunt lock. Authorization locks must have one documented common order with
account/role writers before this is implemented.

Approval, suspension and replacement save serialize on Template identity.
Deactivation/correction serialize on catalog row locks. Test both acquisition
orders: selection-first commits the pre-change artifact; writer-first forces a fresh
check and specified conflict. Approval after selection may move authority only after
the old snapshot commits. Concurrent selections and publish on the same Hunt serialize
on the Hunt row; selection must recheck draft status. Existing draft PATCH and
publish paths must participate in this serialization so they cannot overwrite a
new source tuple or publish a half-selection.

Rollback all source fields on validation/write/deferred-commit failure; release a
reusable pooled client. Deadlock/serialization retries must rerun authorization and
the complete resolver, never reuse an earlier snapshot or silently choose another
version. Lost-response callers reload the Hunt; a retry can now conflict legitimately.

## 6. Compatibility and activation

Keep legacy GET /api/hunt-templates, /{key}/geography and legacy
PATCH /api/hunts/{id} templateKey behavior category-null only. Do not broaden their
shared resolver or remove category gates. They cannot express expected immutable
classified versions and therefore cannot safely carry C7 by an implicit extension.
The explicit new reads and selection endpoint form the new API boundary; no v2
rewrite of legacy APIs is required. Reject classified keys through every old direct
selection path, even when its Local approval is valid.

For a Hunt already selected through C7, reject legacy templateKey replacement with
409 template_selection_conflict; require the explicit Local selection contract.
Ordinary setup/options PATCH remains available under existing rules. No legacy
writer may mutate the Local source fields. A legacy draft may be explicitly switched
to an eligible Local using the new operation, preserving settings.

Universal published_version/library/copy/provenance remain unchanged; Universal is
not directly Organizer-selectable through C7. Preserve category-null platform and
Creator behavior, Signal: Cluj-Napoca content/classification, all historical Hunt
snapshots and participant-facing reads. New Hunt source metadata is nullable for
legacy/history; do not retrofit it. No automatic classification, backfill, propagation,
review fabrication or withdrawal. Creator/Admin separation and existing private
owner-scoped nondisclosure remain intact.

Actual route registration and any rollout configuration require a separately reviewed
implementation PR and acceptance evidence. This document activates nothing.
Reinstatement is absent, not inferred from reapproval or Locality reactivation.

## 7. Required PostgreSQL acceptance matrix

Future implementation tests, not executed C7 results. Use disposable PostgreSQL,
TEST_DATABASE_URL, real HTTP/model paths and separate connections with deterministic
lock barriers; no skipped integration suites or timing-only race assertions.

| # | Fixture/action | Required assertion |
| --- | --- | --- |
| 1 | Independently approved Creator Local with active matching stored binding | Country/search reuse works; list/detail return exact authority ID/key/version and saved locality/geography; no answers/private evidence; selection succeeds |
| 2 | First draft/submission/request-changes; approved v1 → draft/submitted/changes_requested v2; replacement changes A → B | Initial candidates absent; v1 remains discoverable at A only; v2 content/locality never leaks; B appears only on independent approval |
| 3 | Explicit suspension then replacement approval and Locality reactivation | All new catalog/detail/selection deny; retained pointer/audit/evidence unchanged; no reinstatement |
| 4 | Historical null pointer: bound+independent, unbound+independent, bound evidence-less, self-review, missing/unresolvable pin | Only bound independent matching authority selectable; read performs no capture; others excluded without changing status/pin/reviews; no latest fallback |
| 5 | Two countries, same-name distinct Locality UUIDs, wrong-country and proposal IDs | Exact country+UUID filtering; no name/coordinate inference; prescribed 400/404/409 and empty-list behavior; no cross-country artifact |
| 6 | Inactive, missing, malformed pair; each country/latitude/longitude drift; descriptive-only drift | Material/inactive exclusions, no snapshot rewrite; text-only change retains saved labels and separate current context |
| 7 | Discover v1 then select with exact ID/version/country/locality; forge snapshot/content/key/version metadata | Only server v1 full content and pair persist together; supplied authoritative data rejected; settings retained; new v2 never substituted |
| 8 | Approval, suspension, deactivation, correction versus selection in both lock orders | Selection-first exact old commit or writer-first conflict; no mixed pair, lost suspension, TOCTOU acceptance or partial writes |
| 9 | Two selections; selection versus legacy PATCH/publish; injected write/deferred commit failure | Hunt lock serializes; draft recheck; full tuple atomicity/rollback; settings and old snapshot retained on failure; pooled client reusable |
| 10 | Guest/Participant/Creator-only/Admin-only, blocked/retired/revoked Organizer; multi-role Organizer | Authentication/capability policy enforced before artifact lookup; multi-role works; concurrent revocation covered |
| 11 | Other Hunt organizer, organization member without Hunt role, Supervisor, other Creator authoring | No cross-Hunt writes; initial organization access preserved; source Creator ownership grants no Hunt access; private authoring remains owner-scoped |
| 12 | Universal publication/revision/copy, legacy platform/Creator catalog/geography/templateKey, Signal | Existing semantics pass; classified identities never leak through old routes; Local source protected against legacy replacement |
| 13 | Historical Hunts across candidate/approval/suspension/catalog changes, including draft/published/active | Existing source content/version/pair fingerprints unchanged; participant projection/readiness regression preserved; no new gameplay/publish gate |
| 14 | Later additive schema upgrade/rerun/fresh parity, constraints/direct SQL, source-reference deletion | Nullable history untouched; exact source identity/version and paired locality persist; invalid partial references rejected; no historical backfill |

Report focused/full PostgreSQL results and required repository checks in the later
implementation PR. This documentation PR requires only document/link/example checks
and verification that its diff contains this one Markdown file.

## 8. Explicitly deferred decisions

- G4 route fit, safety/evidence quality, validity/expiry and new publish/start policy
  for already snapshotted Hunts; no claim that catalog eligibility certifies safety.
- Suspension reinstatement, repeated cycles and evidence-less historical remediation.
  C6b-5's one-way suspension boundary remains; no operational SQL reset.
- FE D10 screens, Participant runtime, provider integration/storage entitlement,
  attribution and Mapbox persistence; manual/stored catalog suffices here.
- Broader country availability, no-query enumeration, inventory counts/search UX and
  optional atomic create-with-selection convenience API. Existing two-step creation
  is the minimal contract.
- Final additive storage column names and shared account/role lock ordering must be
  reviewed in the implementation design; the exact immutable tuple, authorization
  and race outcomes above are requirements, not optional decisions.
- Deployment/feature activation and complete supply-chain acceptance remain separate
  review gates. No new category or generic workflow framework.

Deliver one documentation-only Draft PR and stop for ChatGPT review. Do not merge
or deploy.
