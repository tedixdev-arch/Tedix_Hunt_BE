# F7/G4 C6a — V1 Country/Locality Contract

**Proposed behavior — Product Owner review required.** Documentation only, revised 28 October 2026.
This replaces the earlier C6a proposal; it does not authorize implementation, merge or deployment.

## 1. Existing implementation baseline

Rechecked current BE main `29ef1d9d808106735b101d65fd1344a546e01b87` and FE main `efe9c282a45bdfcd7b9bd36451270d068d6bdb62`.
References: [C1](F7_C1_Persistence_Foundation.md), [C2](F7_C2_Scratch_Authoring.md), [C3](F7_C3_Published_Universal_Library.md), [C4](F7_C4_Universal_To_Local_Copy.md), [C5](F7_C5_Template_Revisions_And_Republication.md), and [FE Master Architecture Plan v3.6](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/efe9c282a45bdfcd7b9bd36451270d068d6bdb62/docs/TedixHunt_Prototype_Architecture_Implementation_Plan.md), especially F7/G4/D10.

- C1 binds category, owner and exact copy provenance; classified versions are immutable in PostgreSQL.

- C2 supports Universal/Local scratch drafts. Local submission requires complete existing checkpoint/FinishPoint geography; drafts may be incomplete. Universal needs no physical locality or GPS route.

- C4 copies the exact published Universal into an independent Creator-owned Local draft. Later source changes never propagate.

- C5 separates Universal `published_version` from candidate status/`submitted_version`; independent approval atomically republishes. It supports approved Universal revisions and classified changes-requested corrections, **not approved Local revisions**.

- Admin reviews the exact submitted version and cannot approve their own Template. Both classified categories remain excluded from Organizer catalog/geography/direct selection through `category IS NULL` gates.

- Hunt setup uses country/region/city strings and server-created exact Template snapshots. No canonical Locality identity exists.

- Existing FE Mapbox Search Box positions the camera using temporary coordinates; it is not a persistent Locality catalog.
Older FE statements that categories/copy/review protection are absent predate merged C1–C5. Preserve their historical evidence; current BE code governs these implemented details. No deployed E2E or live database inspection is claimed.

## 2. Minimal product/domain rules

The following requirements are already established by the product architecture:

- Universal is reusable, location-independent content. Local is an independent Template, from scratch or copied from an approved published Universal, with its own Creator, versions and independent Admin approval.

- Intended Organizer hierarchy: **Country → Locality → approved, eligible Local Template**. One primary Locality per Local Template version is sufficient for V1.

- Search stored Localities first, then an external provider when needed. Persist new provider locations only after explicit selection and only with permitted storage rights.

- Locality means a catalog identity. City/Town/Village are presentation labels, not different models. Its representative point is neither a checkpoint, boundary nor safety certification.

- Preserve Signal: Cluj-Napoca, legacy behavior, published Universals, historical versions/reviews and Hunt snapshots. No third category, automatic extraction/classification, world import or source propagation.
Everything below is **proposed technical behavior**, including the approved-Local correction policy; unresolved decisions are listed in section 8.

## 3. Minimal proposed database schema

Use three small tables and two nullable columns on the existing version table; no Locality revision or alias tables.

| Structure | Required fields / constraints |
| --- | --- |
| `countries` | `code TEXT PRIMARY KEY` (valid uppercase ISO 3166-1 alpha-2), `display_name`. Small reviewed country reference, no locality import. |
| `localities` | `id UUID PRIMARY KEY`, `country_code` FK, `name`, `administrative_context`, `latitude`, `longitude`, `active BOOLEAN`, creation/update timestamps. |
| Optional Locality metadata | `provider`, `provider_id` as an all-or-none pair, unique together; `provenance` for permitted source/attribution/storage basis. Manual records require provenance describing Admin confirmation. One Mapbox API/ID scope is used in V1. |
| `locality_proposals` | UUID, Creator FK, proposed country/name/context/coordinates, supporting explanation, optional source URL, `status` (pending/accepted/rejected), timestamps. Decision records Admin FK/reason/time; accepted requires resolved Locality FK, other states have none. |
| `hunt_template_versions` additions | Nullable `locality_id` FK RESTRICT and `locality_snapshot JSONB`, both absent or both present. Only Local versions may set them. Server inserts the allowlisted snapshot with the new immutable version. |

Names/context must be nonblank and bounded; coordinates finite within latitude ±90 and longitude ±180. Context may state that no subdivision applies, supported by the source; do not invent a region.
Snapshot contains ID, country code/display name, locality name/context, representative coordinates and any required permitted attribution/provenance. Private proposal evidence/reviewer identity stays outside it.
The snapshot freezes what was selected/reviewed; the FK supplies stable catalog identity. Existing classified-version immutability protects both new columns without an extra association workflow.
No UNIQUE(name), name/country uniqueness or coordinate uniqueness: same-name settlements must remain distinct.
Accepted Locality UUIDs are never reassigned or deleted while referenced. Ordinary Admin corrections update current catalog fields; previous Template snapshots remain unchanged.
An edit identifying a different real-world place must create/reuse a different UUID. Provider identity cannot be silently rebound; ambiguous corrections need review.
An `active=false` record remains historically readable but cannot be newly selected/submitted/approved. Provider downtime alone never deactivates it.
No separate immutable Locality history is indispensable: immutable Template snapshots preserve approved context; current registry corrections record Admin actor, reason and time on the Locality row, without a separate history engine.

## 4. Simple lookup and manual fallback flows

**Lookup:** select Country → search stored active Localities → request provider search if missing → explicitly choose a qualified result → BE reuses/creates Locality → Creator saves its ID on a Local version.
Search never creates rows. Results show country, administrative context and coordinates so same-name places can be distinguished; never auto-select the first result.
For an exact permitted provider/ID match, reuse its UUID after checking country/context consistency. Otherwise check plausible existing matches before insertion.
Name/proximity similarity is only a duplicate warning: user selects a known identity or Admin resolves ambiguity. No automatic merge or generic alias manager.
Concurrent identical provider selections use the unique provider/ID constraint: losing insertion rolls back, reads the winner and returns it. One transaction creates the entire Locality; new provider/manual insertions lock the selected Country row and recheck duplicate candidates before inserting, using ordinary row locks.
Different provider IDs/manual proposals can still describe the same place; V1 flags plausible matches for Admin rather than promising global semantic deduplication or introducing advisory/distributed locks.

**Manual fallback:** Creator submits country/name/context/coordinates and a short explanation supporting existence and location; a source link is optional, with no mandatory link count.
Admin confirms the facts and duplicate candidates, then either accepts into a new Locality, accepts against an existing Locality, or rejects with a reason.
Pending/rejected proposals have no usable canonical binding. An accepted proposal returns its resolved Locality ID; Creator explicitly saves that ID in a new Local version.
Acceptance does not edit any Template or approve it. Proposals have one decision, no revision history, evidence subsystem or multiple review stages.
Lock the proposal row during decision; only pending may transition. Concurrent/repeated review cannot create two accepted records. Corrections after rejection use a new proposal.
Ambiguous cases remain pending until clarified or are rejected; Admin must not assert equivalence merely to remove a duplicate warning.

**Provider choice/licensing:** Mapbox is the preferred candidate because it is already used; V1 needs no multi-provider framework.
[Search Box documentation](https://docs.mapbox.com/api/search/search-box/#search-box-api-restrictions-and-limits) restricts results to temporary use; storing position data requires discussion with Mapbox. Existing camera search is not storage authorization.
[Geocoding v6 documentation](https://docs.mapbox.com/api/search/geocoding/#storing-geocoding-results) distinguishes temporary results (no caching) from permanent results (`permanent=true`, storage permitted; credit card on file or enterprise contract required).
Conditionally use Geocoding v6 permanent results. Its `place` type generally covers cities/villages; provider `locality` often means sub-city units. Validate actual target coverage/type mapping, rather than accepting POIs/addresses as settlements.
Public docs were rechecked 28 October 2026. The account agreement/entitlement was not inspected; **external-result persistence and snapshot retention remain blocked until rights are verified**, including attribution, sharing, backups and post-termination retention.
Do not persist temporary results, derived fields or provider IDs under an assumed license, including in logs/caches or selection references. Manual fallback cannot launder restricted provider data.
Provider failure returns an explicit unavailable/retry state; stored Localities and draft saves still work. No fabricated fallback, shared raw-result cache or automatic refresh job.

## 5. Minimal API contracts

All additions below are proposed. Reuse existing Creator version/submission and Admin Template-review APIs; no locality-specific Template lifecycle.
New read endpoints return only catalog fields; owner/Admin proposal views may include the private explanation.

| Operation | Request / response and behavior |
| --- | --- |
| Country lookup | `GET /api/geography/countries` → 200 `{"countries":[{"code":"RO","displayName":"Romania"}]}`. |
| Stored search | `GET /api/geography/localities?countryCode=RO&q=Cluj` → 200 `{"localities":[],"providerStatus":"not_requested"}`. |
| External search | Same GET with `includeProvider=true` → separate `providerCandidates` and explicit `providerStatus`; no creation. Bounded query/results, country required. |
| Existing ID resolution | `GET /api/geography/localities/{id}` → 200 catalog fields and active flag; unknown UUID 404. No provider dependency. |
| Select external result | `POST /api/geography/localities/resolve` with `{"selectionReference":"...","expectedCountryCode":"RO"}` → 201 created or 200 reused, `{"localityId":"...","outcome":"created"}`. |
| Propose manually | `POST /api/creator/locality-proposals` with country/name/context/coordinates/explanation and optional sourceUrl → 201 `{"id":"...","status":"pending"}`. |
| Read proposals | `GET /api/creator/locality-proposals/{id}` owner-only; Admin `GET /api/admin/locality-proposals?status=pending` and `/{id}` provide the review queue/detail. |
| Decide proposal | `POST /api/admin/locality-proposals/{id}/review` with `{"decision":"accepted","existingLocalityId":"...","reason":"Same place confirmed"}`; omit existingLocalityId to create from reviewed proposal. Reject with decision rejected and reason. 200 includes status and resolved localityId only when accepted. |
| Associate Local | Existing create/version POST adds sibling `localityId` beside `content`; 201 returns the server-created locality snapshot beside ordinary version data. |

A selectionReference is a short-lived server-signed reference to the displayed, storage-permitted candidate/country/actor; reject tampering/expiry, do not trust client-supplied canonical fields. No candidate table or durable retry service is needed.
For a subsequent Local version, omitted localityId inherits the previous ID **and snapshot exactly**; explicit null clears draft selection; explicit ID takes a fresh server snapshot from the active registry.
Scratch/copy drafts can have no locality. C4 copy starts unresolved regardless of optional Universal geography. Universal/legacy requests cannot set localityId.
Existing submit body stays `{"version":2}`; Local submission requires an accepted active Locality plus existing geographic/gameplay completeness. Pending proposal IDs cannot substitute for localityId.
Admin inspection shows the submitted snapshot and current catalog context separately. Approval rechecks exact submitted version and active Locality; materially changed country/context/coordinates requires request-changes and a new version, never silent snapshot replacement.
Use existing error envelope `{"error":"code"}`: 400 invalid_input/locality_required; 401 unauthenticated; 403 forbidden; 404 absent/other-owner; 409 locality_ambiguous, country_locality_mismatch, stale_selection_reference, locality_unavailable or proposal_not_reviewable.
Provider failure during resolve is 503 provider_unavailable; absent storage entitlement is 503 provider_storage_not_authorized. Search may return 200 stored results with degraded providerStatus; outage is not an empty successful search.
Retain existing Template lifecycle/stale-version/self-approval errors. Retries reuse a unique provider identity or return the existing terminal proposal decision/conflict; no new durable idempotency store or promise of identical replay responses.

## 6. Authorization and essential integrity

- Persisted active non-guest Creator: lookup, provider selection, own proposals and own Local association. Admin-only/Organizer-only capability does not grant Creator authoring.

- Admin: lookup and manual confirmation/correction; proposed self-acceptance of their own locality proposal is forbidden. Existing Template self-approval prohibition remains.

- Organizer: stored country/locality reads and eventual eligible Local selection, not manual/provider writes. Participant-only/guest access is denied; blocked/retired accounts follow existing authentication rules.

- Authorize before lookup; retain indistinguishable other-owner/missing 404. Keep provider credentials, proposal evidence, private drafts and review identities out of catalog responses.

- Validate ISO membership, country agreement, coordinates, provider feature type and provenance. Use parameterized queries, bounded requests and fixed provider URLs; do not crawl arbitrary evidence URLs or expose raw query/token logs.

- Save new version + locality FK/snapshot in the existing identity-locked transaction. Submission/approval lock Template then Locality and recheck current state; registry corrections never acquire Template locks.

- Provider HTTP occurs before the short DB transaction. Unique constraints, FKs, row locks and rollback handle exact-identity races/partial failures; ambiguous identities go to human review.

- Schema constraints reject Universal/legacy locality bindings and invalid ID/snapshot combinations. Submission/approval gates must also cover direct/internal paths, not just UI validation.

## 7. Legacy/version compatibility and approved Local correction

No historical backfill, automatic string conversion, Signal classification, or UPDATE of approved version/snapshot content.
Existing versions without locality columns remain readable. New Local drafts may omit selection; when gates activate, pending unbound Local submissions need request-changes/new version, not an association retrofit.
Previously approved unbound Locals need a new reviewed version before future classified eligibility. Legacy/unclassified routes retain existing behavior; their strings are not canonical UUIDs.

**Smallest proposed C5 extension:** allow the original owner of an approved Local to use the existing next-version POST, just as an approved Universal can today.
Under the same identity lock, insert a complete immutable Local version (including locality binding), set status draft and clear submitted_version. Then reuse existing submit → independent exact-version Admin review.
Earlier approved versions/review evidence and Hunt snapshots remain untouched. No new lifecycle enum, publication table, release step or approval inheritance is needed.
Recommend that a Local under correction is unavailable for **new** selection until reapproved; already saved Hunt snapshots remain unchanged. This availability policy requires PO approval (U2), not an assumed product decision.
Do not extend Universal-only published_version to Local silently. If continuous selection of the previous approved Local is required during correction, design that separately before implementation.
Keep all classified Organizer gates closed through this slice. Later G4/D10 must provide the shared eligible Local resolver, country/locality/version checks and server-created Hunt locality snapshot together with the exact Template snapshot.
An inactive/corrected registry row does not rewrite historical Hunts. Consequences for future Hunt publishing/start and route-safety validity belong to the separate G4 policy, not catalog identity.

## 8. Genuine unresolved decisions

| ID | Approval needed before implementation/activation |
| --- | --- |
| U1 | Confirm Mapbox account storage/immutable-retention rights, attribution/cost and representative city/town/village coverage; approve the country reference source and target-country/type mapping. No permanent entitlement is assumed. |
| U2 | Approve the minimal approved-Local revision extension and temporary removal from new selection during correction; settle handling of existing pending/approved unbound Locals before enabling gates. |
| U3 | Confirm manual-proposal self-review prohibition, minimum supporting explanation standard and private proposal retention. No fixed evidence-link quota is proposed. |
| U4 | G4 evidence/validity/withdrawal and corrected/inactive Locality effects on already-approved selection and saved-Hunt publish/start; D10 activation remains dependent on those decisions. |
The simplified schema/API/snapshot placement is proposed for technical review, not existing implementation. None of these open decisions authorizes C6b here.

## 9. Small sequential implementation PR plan

| PR | Scope / dependency |
| --- | --- |
| C6b-1 | After schema/country review: additive countries/localities foundation, constraints and internal lookup only; preserve history. |
| C6b-2 | After U1: Mapbox search and explicit on-demand resolve with unique-identity race handling; no multi-provider layer. |
| C6b-3 | After U3: minimal proposal table, Creator submit/read and one Admin decision transaction. |
| C6b-4 | Add version locality FK/snapshot and progressive authoring; after U2, enable approved-Local corrections through existing C5 mechanisms. |
| C6b-5 | After U2 rollout review: Local submission/exact-review locality checks and compatibility tests. Classified Organizer gates stay closed. |
Each is a separate reviewable BE PR, not authorization to implement. U4/G4 eligibility, D10 FE and deployed supply-chain verification follow separately before Participant runtime.

## 10. Essential acceptance tests

These are future implementation tests, not executed results:

- Fresh/upgrade schema parity; unchanged legacy/Signal/version/review/Universal publication/Hunt fingerprints; no automatic conversion.

- Stored lookup works without provider; explicit provider selection creates once/reuses; correct country/type/context and same-name different-region display.

- Same-provider-ID concurrent selection yields one UUID and no orphan after failure; nearby/different-ID ambiguity never silently merges.

- Provider outage/license failure/expired reference is explicit; no temporary-result persistence; existing choices and incomplete drafts still usable.

- Pending/rejected manual proposals cannot satisfy submission; independent Admin accepts/reuses/rejects once; unauthorized/other-owner/self-review cases fail.

- Atomic new-version FK/snapshot; inheritance versus explicit refresh/null; Local completeness/exact review enforced; Universal requires neither locality nor GPS.

- Approved Local correction uses new version and fresh independent review; chosen availability policy enforced; historical approvals/Hunts and Universal publication remain unchanged.

- Catalog/geography/direct Hunt selection remain closed for classified Templates until separately reviewed G4/D10 activation; snapshot stability survives registry correction.
Documentation checks for this revision: verify Markdown structure, example JSON, repository links and one-file PR scope. No code tests, migrations, provider-account access, deployed verification, merge or deployment are claimed.
