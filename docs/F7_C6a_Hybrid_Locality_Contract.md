# F7/G4 C6a — Hybrid Country/Locality contract

Status: **PROPOSED — architectural review required**. Documentation only, 28 October 2026. No implementation, migration, endpoint, FE change, merge or deployment is included. C6a defines identity/resolution; it does not complete G4 safety governance or activate D10.

## 1. Authority and current implementation baseline

### 1.1 Inspected sources

Latest GitHub `main` trees inspected on 28 October 2026:

| Repository | Pinned main | Authority inspected |
| --- | --- | --- |
| Backend | `29ef1d9d808106735b101d65fd1344a546e01b87` | [F7 proposal](F7_Backend_Template_Contract_Proposal.md), [C1](F7_C1_Persistence_Foundation.md), [C2](F7_C2_Scratch_Authoring.md), [C3](F7_C3_Published_Universal_Library.md), [C4](F7_C4_Universal_To_Local_Copy.md), [C5](F7_C5_Template_Revisions_And_Republication.md); schema, migrations 016, 018–019, 021–023, models, geographic validation, Creator/Admin/Organizer routes and authentication. |
| Frontend | `efe9c282a45bdfcd7b9bd36451270d068d6bdb62` | [Master plan v3.6](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/efe9c282a45bdfcd7b9bd36451270d068d6bdb62/docs/TedixHunt_Prototype_Architecture_Implementation_Plan.md), particularly F7 hybrid catalog, G4, D10, section 14 and 20.2; [architecture audit](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/efe9c282a45bdfcd7b9bd36451270d068d6bdb62/docs/TedixHunt_Architecture_Audit_and_Critical_Path_v1.md); MapboxLocationSearch and walkingRoute source. |

No repository AGENTS.md was present in either inspected tree. The supplied local BE checkout ended at C3 (`95da8c3`); it was not used as current-main authority. Reads were pinned through the GitHub connector after direct Git fetch failed. No live DB, provider account, negotiated agreement, deployed revision or deployed E2E was inspected.

**Reading labels:** “Existing” means observed source behavior at the BE pin above. “Approved requirement” means the product model in the master plan/F7 approved product rules and this task. Everything introduced below is a **proposed technical decision**, subject to the approval register in section 12. Historical documentation evidence is not a new test result.

### 1.2 Existing implementation

| Area | Existing behavior and source |
| --- | --- |
| Identity/version | [migration 022](../src/db/migrations/022_template_classification.ts) binds nullable category to immutable identity/version metadata and immutable exact-source provenance. NULL means legacy/unclassified, not a third category. Classified versions are protected from UPDATE in PostgreSQL. No Locality UUID exists. |
| Scratch and copy | [Creator routes](../src/routes/creatorTemplates.ts) accept `universal` or `local` at scratch creation. C4 `POST /api/creator/templates/from-universal/{sourceKey}` copies the exact currently published Universal into an independently owned Local draft; only content key/version are remapped. Optional source geography remains unapproved draft content. Source identity/version/Creator/approved decision remain immutable lineage. |
| Publication/revisions | [migration 023](../src/db/migrations/023_template_publication.ts) and [PublishedUniversal](../src/models/PublishedUniversal.ts) use `published_version` plus exact independent approval, independently of candidate status/submitted_version. Universal revisions and classified changes-requested corrections create new immutable versions. Approved Local revision is **not** enabled. C4 locks the source identity and re-resolves publication after the lock; stale references fail. |
| Geography | [creatorTemplates validation](../src/domain/creatorTemplates.ts) permits progressive drafts. Local submission requires count 1–20, N uniquely numbered normal positions and gameplay entries plus a separate FinishPoint/terminal entry. Names are nonblank and at most 100 characters; latitude/longitude are finite within ±90/±180; radius is 5–500 m. Normal-position radius accepts finite numbers; FinishPoint radius requires an integer. Universal never needs a fixed route, physical locality or GPS positions. Supplied optional geography is validated. |
| Review | [HuntTemplate model](../src/models/HuntTemplate.ts) and [Admin routes](../src/routes/adminTemplateReviews.ts) review the exact submitted pin. Classified decisions require the inspected version. Self-approval is denied; independent decision evidence is persisted atomically. Self-request-changes remains allowed. Local approval does not inherit Universal approval. No canonical locality or route-safety certification gate exists. |
| Selection | Shared approved resolvers require `category IS NULL`; **both classified categories remain excluded**, including approved Locals. Legacy Creator selection pins submitted_version; platform selection uses its latest saved version. [Professional catalog/geography](../src/routes/huntTemplates.ts) requires persisted Creator, Organizer or Admin capability, excludes guest/Participant-only access, and projects an allowlist. |
| Hunt setup | [Hunt](../src/models/Hunt.ts), [Hunt routes](../src/routes/hunts.ts) and [readiness](../src/domain/huntReadiness.ts) use country/region/city strings. Draft PATCH resolves templateKey server-side into exact version/content snapshot; clients cannot supply that snapshot. Readiness requires country/city text but does not validate canonical geography or current G4 validity. Hunt-specific Organizer authority is separate from platform role. |
| Mapbox | [MapboxLocationSearch](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/efe9c282a45bdfcd7b9bd36451270d068d6bdb62/src/components/MapboxLocationSearch.tsx) uses Search Box suggest/retrieve, a session token, 300 ms debounce, cancellation, finite coordinate checks and a Search by Mapbox link. It returns temporary center/bbox for camera positioning, not a persisted provider ID or canonical Locality. Walking-route estimates are a separate provider operation, not safety evidence. |

### 1.3 Older documentation reconciled with current code

- FE F7/G4 diagrams and the pinned audit describe categories, copying, self-review enforcement and review history as planned/absent. BE C1–C5 now implement the named category/copy/publication/review foundations. The audit's historical findings remain valid for its own older pins; they are not current BE absence claims. The inspected current professional geography route also closes the audit's historical Participant inspection gap.
- The initial F7 proposal reserves storage/provenance/publication/revisions; C1–C5 settle their implemented slices. C3/C4's old status-plus-submitted publication predicate is superseded by C5 `published_version`. Never restore it during C6.
- C2's earlier “submitted/approved uneditable” and no correction path is narrowed by C5: changes-requested classified corrections and approved Universal revisions now work; approved Local revisions still do not.
- FE's older blanket statement that immutable versions lack DB triggers no longer describes classified rows after 022. Legacy behavior is deliberately retained. FE's integer normal-radius wording also differs from current BE finite-number validation; C6 does not change radii.
- Locality identity, provider licensing, manual acceptance, G4 evidence/operating validity, classified Organizer eligibility and D10 remain unimplemented. Neither merged C1–C5 nor this document proves deployed supply-chain E2E.

## 2. Approved requirements and proposed minimal architecture

**Approved requirements:** Universal is reusable location-independent content. Local is an independent location-specific Template, authored from scratch or copied from an approved published Universal. Approval is independent; later Universal publication never changes a Local or Hunt snapshot. Organizer eventually selects independently approved eligible Local versions. Preserve Signal, legacy records, immutable content and snapshots. No third category, extraction, automatic classification, extra release workflow or worldwide locality import.

**Proposal:** keep a small on-demand Country/Locality registry in BE/PostgreSQL. Search internal records first; consult one licensed provider only when requested/needed; explicitly select an existing identity or a provider candidate. Accept manual proposals through bounded Admin review. A Local Template version binds an immutable locality revision, not a free-text name, current provider response or mutable shared label.

City/Town/Village are optional presentation labels on **Locality**, never separate models. Provider `locality` is not automatically the TedixHunt domain concept: Mapbox `place` generally describes cities/villages, whereas its `locality` often denotes sub-city administrative units. V1 provider adapter proposes `place` candidates; other valid locality types require explicit reviewed mapping/manual acceptance. Streets, POIs, addresses and neighborhoods cannot become localities merely because they have coordinates.

Logical flow: existing identity search → explicit existing selection OR licensed external candidate → exact-provider match/duplicate checks → on-demand persistence → new Local version association → exact submission and independent Local review. Manual pending/rejected proposals are outside the accepted registry and cannot satisfy submission.

One primary Locality per Local version is the proposed V1 scope. This is a catalog anchor, not a legal boundary polygon, route, checkpoint or safety certification. Cross-locality routes require a later policy; do not silently invent multiple associations or reject every route crossing an administrative boundary.

## 3. PostgreSQL schema proposal

This is a relational design, **not executable DDL or a migration**. Types, limits and constraints below are proposed. No PostGIS, country-wide city dataset or generic geographic hierarchy engine is needed for V1.

### 3.1 Country and Locality records

| Relation / key | Required fields | Optional metadata / constraints |
| --- | --- | --- |
| `countries`, `code TEXT` PK | Valid uppercase ISO 3166-1 alpha-2 code, display_name, selectable boolean, dataset_version | Small versioned country reference only; no cities. CHECK uppercase two-letter syntax plus FK membership validation. Retain historical codes as nonselectable; names are presentation, not keys. Dataset source/disputed-territory policy needs L08 approval. |
| `localities`, `id UUID` PK | current_revision positive integer, lifecycle (`active` or `unavailable`), created_at, updated_at, row_revision positive integer | unavailable_reason and changed_by_user_id required on unavailability. Stable UUID never recycled. Composite FK `(id,current_revision)` to locality_revisions, deferred for atomic creation. No physical deletion of referenced accepted identities. |
| `locality_revisions`, PK `(locality_id,revision)` | country_code FK, canonical_name, administrative_context, latitude, longitude, provenance_kind (`provider` or `manual`), source_reference, recorded_at, recorded_by_user_id, rights_basis | Optional admin1_code/name, admin2_code/name, localized names, presentation_label, bbox, provider feature_type, attribution metadata. Trimmed name 1–200 characters; context 1–300. Finite coordinates within ±90/±180; explicit latitude/longitude fields avoid GeoJSON ordering confusion. Context may explicitly say no applicable subdivision, with evidence; do not fabricate region codes. |
| `locality_provider_refs`, UNIQUE `(provider,namespace,external_id)` | id UUID PK, locality_id FK RESTRICT, provider, namespace, external_id, first_seen_at, last_verified_at, rights_basis | namespace records API/dataset/worldview identity scope; no cross-API ID equivalence assumed. Link is immutable once accepted; retirement/alias notes may be appended under Admin authority. Multiple external references may resolve to one internal UUID only after reviewed equivalence. Raw provider JSON is not required. |

The revision PK also references localities.id (deferred insert cycle). Accepted revisions are insert-only, with durable actor FKs using the existing account-retirement convention, and restrictive references. Provider revisions must reference a matching accepted provider_ref and allowed storage basis. Manual revisions reference the accepted proposal UUID as source_reference. All accepted records have provenance; provider identity is required only for provider-sourced records. Review/actor fields are private. No provider token is stored in provenance.

Provider-derived acceptance means identity accepted under the approved adapter rules, **not Admin route approval**. Pending/rejected are proposal states, not usable locality lifecycle states. `unavailable` disables future selection/approval; temporary provider outage alone never changes an accepted locality's lifecycle. Renaming/correcting a real locality creates a new revision with reason/actor and preserves UUID. A correction revealing a different real-world entity creates/reuses a different UUID, never reassigns the old one.

Index country/name for internal search and country/admin context for duplicate candidates; normalized/accent-insensitive search keys are non-authoritative. There is deliberately no UNIQUE(name), UNIQUE(country,name), coordinate uniqueness, spatial-distance merge rule or automatic case/accent collision merge. Fuzzy/nearby matches are suggestions only. Start with bounded indexed queries; add search extensions only if measured need justifies them.

### 3.2 Manual proposal and version association

| Relation / key | Required fields / invariant |
| --- | --- |
| `locality_proposals`, `id UUID` PK | creator_user_id, country_code FK, proposed_name, administrative_context, latitude, longitude, explanation, evidence references, status (`pending`, `accepted`, `rejected`), created_at, revision. Same field bounds as accepted revisions; explanation 1–2000, 1–5 HTTPS evidence references. Decision requires reviewer_user_id, reviewed_at, decision_reason and exact inspected proposal revision. Accepted requires resolved_locality_id/revision FK; pending/rejected have no resolved binding. Review outcome/inputs become immutable. |
| `template_version_localities`, PK `(template_id,version)` | Composite FK to hunt_template_versions RESTRICT; locality_id/locality_revision FK RESTRICT OR proposal_id FK RESTRICT OR neither for unresolved draft, never both. `contract_revision = 1` and recorded_at. Server inserts alongside the new version and never updates the binding. Trigger checks owning version category `local`; Universal/legacy bindings forbidden. |

Create one association row for every newly saved Local version after contract activation, even if its selection is null. Older versions without a row stay explicitly historical/unbound; absence is not a bypass for newly submitted classified Local candidates. A proposal reference preserves draft intent, but accepting the proposal does not edit that version: Creator saves a new immutable version with the resolved locality reference. A pending proposal can be a draft association only; it is never a locality UUID.

Server-generated response `localitySelection` is a separate envelope beside existing content/category; do not insert reserved metadata or provider blobs into extensible gameplay JSON. Exact immutable revision joins provide historical display data. Future D10 must copy this selected revision's allowlisted display/coordinates/provenance into a server-created Hunt `locality_snapshot`, alongside nullable `locality_id`/`locality_revision` columns. That future additive Hunt change must be atomic with template key/version/content selection and must not alter the original content JSON snapshot. Old Hunts keep all new fields NULL.

### 3.3 Integrity and rollout

SQL constraints protect state combinations, FKs, uniqueness and immutability. Service transactions enforce persisted capability, accepted lifecycle, exact revision, matching country, licensing and version/category rules; deferred DB checks must also prevent direct SQL from inserting a submitted/approved post-activation Local without a valid accepted binding. This cross-table enforcement needs deliberate migration design alongside 022's classified-version immutability; never UPDATE existing version rows to add associations.

Stage schema first with nullable additive structures; inventory existing classified Locals and submitted candidates before enabling new gates. Proposed activation blocks new classified Local submission and any still-pending Local approval without a valid association. Already immutable unbound candidates require request-changes/new version, not a sidecar retrofit. Existing approved unbound Locals remain historical and Organizer-ineligible; approved Local revision remains a separate unresolved capability (L06). Legacy APIs and `category IS NULL` selection continue unchanged. No backfill from country/region/city strings.

## 4. Lookup, resolution, duplicates and ambiguity

1. Country lookup uses the versioned small ISO reference, independent of the provider. A valid country code does not promise provider coverage or any eligible Template.
2. Internal search requires country; query/name/admin context narrows a bounded page of active localities. Return UUID, exact current revision, canonical name, context and representative coordinates. Do not return proposal owners/evidence or Template counts that expose private drafts. Exact UUID resolution works offline from the provider.
3. With `includeProvider=true`, consult the approved adapter if internal choices are insufficient. Search has no DB creation side effects. Keep internal and external candidates explicitly distinct. Never auto-select the first result. Return provider status even when internal results exist, so an outage cannot appear to mean no matches.
4. Server validates external feature type, country, context, finite coordinates and rights basis. Retain a short-lived actor-bound selection reference only for a storage-permitted candidate. Client names/coordinates/provider IDs cannot be trusted as resolved facts. Reference binds provider namespace/ID, full displayed candidate hash, country, language, worldview, expiry and licensing-policy version.
5. Selection rechecks those facts. An existing exact `(provider,namespace,external_id)` reference reuses its locality UUID if context remains consistent and lifecycle/revision is usable. Changed country/type or materially different context/coordinates is a conflict requiring review; never silently update shared identity from a new response. Exact ID equality does not override incompatible context.
6. If no exact match exists, compare country, name variants, administrative context and coordinates to identify possible duplicates. Two same-name places in different regions stay separate unless evidence proves equivalence. Distinct provider IDs near one another are not proof of distinctness or equivalence. If plausible duplicates exist, return candidates for explicit existing selection or route a proposal to Admin; do not insert another accepted identity by default. Creator may choose an existing UUID but cannot attach a new provider alias or assert a merge.
7. If unambiguous and no potential duplicate remains, explicit selection atomically creates locality identity, revision and provider_ref. No search-result bulk import. If no usable candidate exists, offer the manual proposal route. Missing provider context cannot be filled by guesswork.
8. Ambiguous candidates remain selectable only as their separate fully qualified candidates. Provider malformed/empty results, unsupported countries and failures are separate states. Timeout/unavailable/rate-limited service leaves existing records usable and drafts saveable without a locality; submission still fails until resolved. No fallback to an unrelated result or a different provider without a separately approved adapter/rights policy.

Reconciliation is intentionally small: Admin accepts a proposal against an existing UUID or creates a new one; reviewed external aliases are recorded only with evidence. Already referenced duplicate UUIDs are preserved and may be marked unavailable with a documented suggested replacement. No FK rewriting, automatic redirects on selection, bulk merge tool or general geographic administration UI is part of C6b. Historical UUID resolution must distinguish the old identity from a suggested replacement.

## 5. Provider and caching decision analysis

Public sources checked 28 October 2026; the applicable account/order agreement was **not** available. Public documentation establishes product capabilities/restrictions, not TedixHunt entitlement.

| Option | Verified public facts and proposed consequence |
| --- | --- |
| Existing Mapbox Search Box | [Search Box docs](https://docs.mapbox.com/api/search/search-box/#search-box-api-restrictions-and-limits) restrict results to temporary use and direct storage use cases to sales. Documented coverage is US, Canada and Europe, including Romanian-language queries. Existing FE camera search is useful baseline; do not persist its results, IDs, coordinates or derived canonical fields as this registry under an assumed permanent right. No country-wide/global completeness claim. |
| Mapbox Geocoding v6 | [Geocoding docs](https://docs.mapbox.com/api/search/geocoding/#storing-geocoding-results) distinguish temporary results (no caching) from permanent results (indefinite storage permitted), selected with `permanent=true`; permanent mode requires a credit card on file or enterprise contract. Country/type/language/worldview support and quality vary; a city/town/village usually maps to `place`, not provider `locality`. No POI requirement for this contract. **Conditional preferred adapter**, subject to L01 entitlement/use/retention approval and representative coverage checks. |
| Alternative licensed provider | Not selected or researched as an implementation dependency. If Mapbox rights/coverage fail, review another provider's exact storage, attribution, ID stability, privacy and costs before adapter work; preserve internal UUIDs. Do not silently switch or assume public OSM/Nominatim availability grants unrestricted production caching/service use. |
| Manual accepted records | Essential gap/outage path using independently supplied, reviewable evidence with a documented retention basis. Not a way to relabel prohibited provider data as user-authored. Admin must reject copied restricted results as evidence of independent rights. |

[Mapbox Product Terms portal](https://www.mapbox.com/legal/product-terms) linked an October 20, 2026 PDF during research; the PDF could not be retrieved by the research tool. Therefore this review does **not** certify its full legal conditions or any account-specific overrides. L01 must record the applicable terms/order version and confirm long-term storage of normalized fields, provider IDs, duplicate-check artifacts, immutable Template/Hunt snapshots, backups, cross-Creator display and post-termination retention. If immutable retention is not permitted, do not use that source for accepted identities. A short cache TTL or stripping raw JSON does not cure prohibited derived-data storage.

Proposed cache policy for an explicitly storage-permitted adapter: actor-bound candidate references expire after 10 minutes; internal accepted data does not expire because the provider is down. V1 uses no shared raw-response cache and stores only selected normalized fields/provenance. Search responses use `Cache-Control: no-store`; suppress provider query/results from logs, traces and analytics. Candidate payload retention in encrypted short-lived storage is itself subject to the same rights gate; temporary-only adapters cannot issue persistable selection references. Re-fetch/revalidate when policy requires it; never persist temporary search results while hoping to replace their license later.

Budget external calls with country/type constraints, explicit search action, bounded limit, timeout, server-side rate limits, short circuit breaking and no unbounded retries. A permanent-eligible search may bill every request; confirm cost/quota before enabling. Store non-sensitive request IDs/status/latency for operations, not full queries/results. Future optimizations/TTLs require reviewed terms; no worldwide warming job.

[Mapbox attribution guidance](https://docs.mapbox.com/help/dive-deeper/attribution/) requires appropriate logo/text and data credits for relevant maps. Carry plain-text/link attribution metadata in permitted provider projections and snapshots; render it safely in later FE work and preserve existing map attribution controls. Do not assume the current Search by Mapbox link alone satisfies the new search/storage product. Confirm search-list, non-map display and snapshot/export obligations under L01; no attribution removal or FE implementation here.

Coverage acceptance before enabling: representative Romanian city, town and village; same-name settlements in different regions; diacritics/alternate languages; a valid settlement missing from provider; one intended non-European country; contested-country/worldview behavior. Document actual results and gaps then, rather than treating this proposal as a live-provider test.

## 6. Manual proposal/review workflow

An active non-guest Creator may submit a proposal, read their own proposal/status and reference it in their own Local draft. Creator cannot mark it accepted, create canonical locality fields directly, review it, attach provider aliases or inspect others' private evidence. Organizer-only/Admin-only capability does not confer Creator authoring rights.

Require country, name, administrative context, representative coordinates, explanation of the missing/unusable provider result and 1–5 evidence references establishing existence/context/coordinates and permitted use. Prefer official municipal/geographic sources or independently documented field evidence. No proof of route safety is implied. Do not demand personal home coordinates, identity documents or participant tracking. Evidence URLs are private to proposer/Admin; store only necessary data. V1 does not fetch arbitrary URLs or accept file uploads.

Pending proposals have no accepted UUID and cannot satisfy Local submission or approval. Existing progressive draft saves continue. A provider outage is an allowed explanation but does not entitle automatic acceptance or claim the place is missing permanently.

Admin queue/detail is limited to persisted active non-guest Admin capability. Approval authority is human: verify country/context/coordinates/evidence, rights and duplicate candidates; use expected proposal revision to prevent stale review. Proposed independence rule forbids a combined Creator/Admin from accepting their own proposal. Another Admin may accept it into a new identity or resolve it to an existing exact identity/revision with reason. For a plausible duplicate, prefer proven reuse; unresolved ambiguity stays pending or is rejected with an actionable reason. There is no forced acceptance or automatic merge.

Acceptance atomically writes the canonical records (when new), decision/result binding and audit actor/time. It does **not** approve any Template, edit any Local version or resume submission automatically. Creator must explicitly save the returned accepted reference in a new version and submit normally. Rejection retains inputs/reason for authorized review but provides no locality binding. Correction uses a new proposal referencing the rejected one; V1 has no mutable proposal editing/resubmission engine. Proposal acceptance after rejection is not an undocumented state transition.

Accepted proposal retention/actor attribution follows durable provenance; account retirement must preserve references without publicly exposing personal profiles. Evidence retention periods for pending/rejected proposals remain L07. No generic geo moderation platform, crowdsourced voting or batch country maintenance is proposed.

## 7. Local Template version integration and history

### 7.1 Progressive authoring and validation

Reuse existing scratch and next-version POSTs, extending only classified Local request envelopes with optional `localitySelection`. Authoritative association fields never come from content JSON. On scratch/copy, null selection is allowed. C4 copying remains unchanged: the new Local v1 starts unresolved, regardless of optional source geography. Never derive a locality from a Universal name, route, coordinate or starterSource.

For a subsequent Local version, omitted selection inherits the prior version's binding exactly (including null/proposal), without refreshing the locality revision. Explicit null clears draft selection. An explicit locality binding must name its exact current active revision and expected country; a stale inherited binding may remain as draft history with a warning, but cannot pass submission. Proposal binding must be owned by this Creator. Supplied invalid references fail saving; missing selection does not. These optional-envelope rules are proposed, not current API behavior.

When the new gate is activated, **selection becomes required at Local submission**, not at draft creation. Submission checks the latest requested immutable version and existing C2 geography/gameplay completeness plus: one accepted active locality, exact current revision, selectable country, matching expected country and no unresolved proposal/ambiguity. Recheck under locks before setting submitted_version. Existing legacy/unclassified submission and Universal validation remain unchanged. A Universal request supplying localitySelection fails validation; Universal has no required country, locality or GPS route.

Admin inspection returns the submitted version's exact locality revision/snapshot and current lifecycle/revision separately. Approve requires the same inspected Template version and rechecks locality usability/current revision under lock. Locality acceptance is necessary, not sufficient: independent Admin review, actual route/adaptations and later G4 evidence/validity/blocker checks still apply. C6b cannot open selection because an accepted UUID exists.

### 7.2 Corrections, unavailability and route interaction

| Change | Proposed behavior |
| --- | --- |
| Locality name/context/coordinate correction | Append accepted locality revision; old references remain readable. New selections use current revision. A draft's old binding is visible as stale; saving a new Local version explicitly adopts the revision, then submit/review again. No silent rebinding or checkpoint movement. |
| Correction while Local submitted | Approval fails with locality conflict. Admin uses existing request-changes; Creator saves a new immutable version and resubmits. Pending proposal acceptance cannot mutate the submitted artifact. |
| Locality becomes unavailable | Block new selection, submission and approval; retain historical resolution and reason. Do not fabricate an alternate ID or mark route content changed. Previously approved versions/saved Hunts remain byte-stable. Future G4 must evaluate this mutable condition for catalog/publish eligibility; the exact withdrawal/start policy is L06, not implemented here. |
| Existing approved Local needs correction | C5 has no approved Local revision path. Do not enable one silently. Historical record remains; recovery needs separately approved L06 behavior before public activation. Classified Organizer gates remain closed meanwhile. |
| Provider outages or removed external result | Outage alone has no effect on accepted internal data. A removed external ID is provenance, not deletion authority; verified real-world invalidity may justify Admin unavailability. Preserve old IDs/revisions; no per-read provider dependency. |
| Route/checkpoints disagree with locality | Preserve authored checkpoint/FinishPoint coordinates and order. Flag inconsistent country/context or implausible route for human correction/review. A representative center/bbox is not an authoritative polygon or distance limit. No arbitrary radius-based hard rejection, inferred safe walking path or automatic relocation. |

Cross-border routes, authoritative boundary checks and evidence-validity/withdrawal semantics need G4 decisions before eligible public selection. Checkpoint geography retains existing validation; FinishPoint stays separate from N normal positions. Locality center cannot fill missing checkpoints or GPS. Country mismatch in the selected identity is a hard association error; proving every route point's jurisdiction is a different reviewed evidence problem.

### 7.3 Legacy and immutable snapshot compatibility

Read old country/region/city strings exactly as stored. They are display/context, never canonical UUIDs. No name/coordinate backfill, automatic Signal classification, version rewrite, review rewrite or Hunt snapshot repair. An explicit future legacy adaptation must create a newly reviewed classified identity/version under an approved workflow; C1 category immutability forbids simply relabeling an existing identity.

Version-bound locality revisions and immutable copy provenance coexist: Universal source lineage still identifies its exact historical source, while Local locality choice describes that Local version only. Universal republication does not affect either. Historical reads join pinned locality revisions, never current display values. New Hunt locality snapshots must remain readable without the provider and cannot refresh on Hunt read. Provider-derived snapshot retention must be licensed first.

Future D10 filters should reuse GET /api/hunt-templates and geography, plus existing Hunt PATCH, after G4 approval. All catalog, direct-key selection, geography and save paths must share one eligible-Local resolver, match country/locality/exact Template version and check current governance in the selection transaction. Country changes clear dependent Locality/Template/preview and Locality changes clear Template/preview in the later FE slice. Current APIs do not yet accept these filters/references; C6a does not activate or weaken the legacy resolver.

## 8. Proposed API contracts

All new paths, fields, codes and limits in this section are **proposals, not implemented endpoints**. Auth before lookup; use existing `{ "error": "code" }` with optional safe field/issues details. No raw provider response, token, evidence or reviewer identity in public locality projections. Dates below are illustrative UTC. IDs in examples are valid UUIDs, not production references.

### 8.1 Country lookup and internal resolution

`GET /api/geography/countries?q=rom&limit=20` — Creator/Organizer/Admin professional read.

```json
{
  "countries": [{ "code": "RO", "displayName": "Romania", "selectable": true }],
  "datasetVersion": "iso-reference-review-1",
  "nextCursor": null
}
```

Country query optional; limit 1–50 with opaque cursor. Validate code membership on writes; lowercase input may be normalized to uppercase before lookup and echoed canonically. Invalid country is 400 `invalid_country`; unsupported provider coverage is a separate state. Country lookup does not query a geographic provider.

`GET /api/geography/localities/{id}` — 200 returns accepted internal identity/current projection; optional `revision=1` resolves an exact historical revision, never grants permission to select a stale one.

```json
{
  "locality": {
    "id": "11111111-1111-4111-8111-111111111111",
    "revision": 1,
    "countryCode": "RO",
    "displayName": "Cluj-Napoca",
    "administrativeContext": "Cluj, Romania",
    "coordinates": { "latitude": 46.77, "longitude": 23.59 },
    "lifecycle": "active"
  },
  "currentRevision": 1,
  "selectable": true
}
```

Coordinates illustrate a locality representative point, never an authored checkpoint. Unknown UUID/revision: 404 `not_found`. Known unavailable identity: 200 with lifecycle unavailable/selectable false and safe reason; mutation attempting selection: 409 `locality_unavailable`. Resolution has no persistence side effect.

### 8.2 Locality search

`GET /api/geography/localities?countryCode=RO&q=Cluj&includeProvider=true&limit=10` — professionals may search internal records; **Creator/Admin only** may trigger paid external lookup in proposed V1. Organizer uses internal localities for D10; it cannot create registry records.

```json
{
  "existing": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "revision": 1,
    "countryCode": "RO",
    "displayName": "Cluj-Napoca",
    "administrativeContext": "Cluj, Romania",
    "coordinates": { "latitude": 46.77, "longitude": 23.59 }
  }],
  "providerCandidates": [{
    "selectionReference": "opaque-actor-bound-reference",
    "countryCode": "RO",
    "displayName": "Example village",
    "administrativeContext": "Example commune, Cluj, Romania",
    "coordinates": { "latitude": 46.8, "longitude": 23.6 },
    "expiresAt": "2026-10-28T15:10:00Z",
    "attribution": [{ "label": "Mapbox", "url": "https://www.mapbox.com/" }]
  }],
  "providerStatus": "ok",
  "nextCursor": null
}
```

`q` is trimmed 2–200 characters; country required, page limit 1–20. Internal results use a stable name/context/UUID order with opaque pagination. External results are bounded to the current query and do not pretend to paginate the internal list. Omit exact-provider duplicates already represented internally; return a visible match/conflict when context disagrees. `providerStatus` is `not_requested`, `ok`, `no_results`, `unavailable`, `rate_limited`, `unsupported_country` or `storage_not_authorized`. Empty results with ok/no_results are not an outage. Valid search returns 200 with internal results and degraded status, even if external lookup fails; local service rate limits return 429. No provider writes occur on GET.

### 8.3 Provider-result selection / on-demand persistence

`POST /api/geography/localities/resolve` — active Creator or Admin; JSON fields allowlisted, no arbitrary provider URL/ID/coordinates.

```json
{
  "selectionReference": "opaque-actor-bound-reference",
  "expectedCountryCode": "RO"
}
```

Required `Idempotency-Key: <opaque client UUID>` for this proposed mutation.

```json
{
  "outcome": "created",
  "localityReference": {
    "id": "22222222-2222-4222-8222-222222222222",
    "revision": 1,
    "countryCode": "RO"
  }
}
```

201 when created; 200 `outcome: reused` when exact existing identity won. 409 `locality_ambiguous` includes only safe existing candidate IDs/context and `nextAction: select_existing_or_propose`; no accepted row is inserted. 409 `stale_selection_reference` for expired/changed feature or policy; 403 `invalid_selection_reference` for another actor/tampering without echoing secrets; 409 `country_locality_mismatch`; 503 `provider_unavailable` if required revalidation fails; 503 `provider_storage_not_authorized` if entitlement gate is closed. Selecting an existing locality needs no resolve POST: use GET then its exact reference in authoring.

### 8.4 Manual proposal and Admin review

`POST /api/creator/locality-proposals` — Creator, Idempotency-Key required.

```json
{
  "countryCode": "RO",
  "displayName": "Example village",
  "administrativeContext": "Example commune, Cluj, Romania",
  "coordinates": { "latitude": 46.8, "longitude": 23.6 },
  "explanation": "No suitable provider result; official locality evidence supplied.",
  "evidence": [{ "url": "https://example.org/official-locality-register", "note": "Reviewed public register entry and coordinate source" }]
}
```

201: `{ "proposal": { "id": "33333333-3333-4333-8333-333333333333", "revision": 1, "status": "pending" } }`. Exact repeated actor/payload/key returns same outcome. Possible duplicates are returned as warnings with safe IDs; proposal creation is allowed so Admin can reconcile, never treated as accepted. Invalid/missing evidence is 400 `invalid_input`. Owner-scoped `GET /api/creator/locality-proposals/{id}` returns own inputs/status and safe decision/result; other-owner/missing both 404. `GET /api/admin/locality-proposals?status=pending` and `/{id}` expose the bounded Admin queue/detail; no unrestricted public proposal listing.

`POST /api/admin/locality-proposals/{id}/review` — Admin, exact revision and Idempotency-Key required. Accept against an existing identity:

```json
{
  "expectedRevision": 1,
  "decision": "accepted",
  "resolution": { "existingLocality": { "id": "11111111-1111-4111-8111-111111111111", "revision": 1 } },
  "reason": "Evidence identifies the same municipality; reuse confirmed."
}
```

200: `{ "status": "accepted", "proposalRevision": 2, "localityReference": { "id": "11111111-1111-4111-8111-111111111111", "revision": 1, "countryCode": "RO" } }`. For a genuinely new accepted place, use `resolution: { "createFromProposal": true }`; server copies the exact reviewed fields and records rights_basis from the Admin's reviewed evidence, never arbitrary canonical overrides. Rejection body: `{ "expectedRevision": 1, "decision": "rejected", "reason": "Evidence does not distinguish the named settlement." }`; 200 returns rejected/revision 2 with no localityReference. Other decisions/combinations fail 400. Needed input corrections require a new proposal.

409 `proposal_not_reviewable` covers stale/already decided state (except exact idempotent replay); 403 `locality_self_review_forbidden` blocks own acceptance; 409 `locality_ambiguous` leaves pending if duplicate checks cannot resolve; cross-country reuse returns 409 `country_locality_mismatch`. Locality acceptance does not replace either category's Template review.

### 8.5 Local Template association through existing APIs

Extend `POST /api/creator/templates/{key}/versions` (and scratch create) with a sibling of `content`:

```json
{
  "content": {
    "key": "my-local-hunt",
    "version": 2,
    "displayName": "My Local Hunt",
    "theme": "Signal",
    "mission": { "brief": "Find the signal" },
    "configuration": { "normalCheckpointCount": 1 },
    "scoring": { "completion": 100 },
    "checkpoints": [{ "checkpoint": 1, "role": "normal" }]
  },
  "localitySelection": {
    "locality": { "id": "11111111-1111-4111-8111-111111111111", "revision": 1 },
    "expectedCountryCode": "RO"
  }
}
```

This is a valid progressive draft example, deliberately not submission-complete. 201 retains existing key/version/status/origin/category/content response and adds server-generated localitySelection and localityValidation (`ready`, `missing`, `proposal_pending`, `proposal_accepted_requires_new_version`, `proposal_rejected`, `stale` or `unavailable`). Pending draft alternative: `"localitySelection": { "proposalId": "33333333-3333-4333-8333-333333333333" }`; clear via explicit null. Unknown/extra/conflicting selection fields fail 400 `invalid_input`. Same-owner proposal rejected as a new selection returns 409 `proposal_not_usable`; already stored rejected intent remains readable.

No locality PATCH mutates an existing version. Save/version allocation and association insert commit together; failure rolls back both. Missing selection may save, but existing `POST /api/creator/templates/{key}/submit` with `{ "version": 2 }` returns proposed 400 `locality_required`/`locality_unresolved` or 409 `stale_locality_reference`/`locality_unavailable` as applicable. Existing invalid geography still returns its current 400 validation error. Existing lifecycle/version/ownership errors retain their semantics; this does not add idempotency to C4 or other existing authoring calls.

Existing Admin `POST /api/admin/templates/review/{key}/approve` with `{ "version": 2 }` retains classified exact-version requirement; a now-stale/unavailable/missing locality causes 409 `template_locality_not_reviewable` without changing status/review. Request-changes stays available to resolve it. Owner reads and Admin exact-version inspection add allowlisted pinned locality information; private manual evidence remains in the separate authorized proposal review view.

## 9. Security, authorization and privacy boundaries

| Actor | Proposed access |
| --- | --- |
| Active persisted Creator | Internal/external lookup, existing resolution, explicit provider persistence, own proposals, own Local version association. Cannot accept canonical manual records, rebind other owners or bypass submission. |
| Active persisted Admin | Professional lookup, provider resolution, proposal review and canonical correction/unavailability with reason. Does not acquire Creator ownership/authoring solely by being Admin. Independent Template self-approval prevention remains unchanged. |
| Active persisted Organizer | Internal country/locality read only; later eligible catalog/filter and Hunt-specific Organizer selection. Cannot create localities/proposals or edit Templates. |
| Guest/Participant-only/blocked/retired | No privileged geo search, authoring or evidence inspection. Existing authentication returns 401 for blocked/retired; active insufficient capability returns 403. Multi-role users use persisted capabilities, never client role claims. |

Use existing requireAuth/requireAnyRole conventions, re-read active capability before committing new canonical/review writes, and lock relevant user/role rows where revocation races matter. Authorization precedes lookup. Owner checks belong in SQL; indistinguishable missing/other-owner 404 prevents proposal and draft enumeration. Country/locality projections are professional registry data, not a participant route-disclosure API; do not include answers, private Template references or evidence.

Provider tokens remain server-side for new BE operations; allowlist host/path and adapter parameters to prevent SSRF. No user-supplied fetch URL, generic proxy, arbitrary provider selection or automatic evidence URL crawling. HTTPS evidence links are stored as inert text with length limits, escaped labels and safe links; no raw HTML. Parameterized SQL, payload limits, rate limits and bounded queries apply. Do not forward actor UUID/email, participant GPS or entire authored routes to locality search; country/text is sufficient. Query logs can reveal sensitive locations: suppress bodies/URL query strings on geo paths, redact authorization/idempotency/selection references, keep only operational aggregates.

Correction/unavailability is Admin-only, auditable and narrowly scoped; there is no hard-delete/merge endpoint in V1. Required audit data is separate from public labels. Account retirement must retain evidence-backed UUID provenance without exposing personal profile snapshots; no new cascading user-deletion FK.

## 10. Errors, concurrency, transaction boundaries and idempotency

External requests happen **outside** long DB transactions. Verify permitted result material/reference first; then short transaction rechecks actor, rights-policy revision, duplicate state and accepted identity. No database lock is held while waiting for provider HTTP. If revalidation changes the displayed candidate, fail stale rather than substitute.

| Race/failure | Required proposed result |
| --- | --- |
| Two actors select same exact external reference | Unique provider tuple is final arbiter. Serialize on tuple/advisory lock; loser rolls back any tentative identity/revision, freshly reads winner, checks country/context/lifecycle and returns reused. No orphan locality. |
| Two different external IDs or manual proposals plausibly identify same place | Serialize candidate checks in a country-scoped transaction advisory lock (low-volume V1; not proximity identity). Requery duplicates after acquiring lock. Second transaction returns ambiguity/reuse review, not automatic same-name merge or unchecked duplicate creation. Apply this lock to all new canonical/alias/correction writes. |
| Proposal review races/retries | Lock proposal, compare expected revision/status and recheck Admin. One terminal decision; idempotent replay returns original result. A conflicting decision is 409. Canonical insertion/accepted mapping/audit/idempotency result roll back together. |
| Local version save races | Existing Template identity FOR UPDATE continues to allocate next version; association insert participates in that transaction. Wrong client content.version retains existing invalid-input/version behavior. No mutable sidecar write after commit. |
| Locality changes during submission/approval | Template identity then locality identity locked; re-read current revision/lifecycle after waiting. Either decision commits against usable exact revision first, or change wins and decision fails. Historical committed approvals are not rewritten. Future G4 eligibility rechecks mutable lifecycle separately. |
| Provider unavailable after known locality selected | Existing resolution/save/submit use internal accepted data. If a new provider selection needs HTTP verification, fail 503 and retain draft. No partial accepted rows. |
| Crash after DB commit / lost response | Idempotent new geo/proposal/review mutation retry recovers persisted original status/body. No second accepted row/decision or extra provider call needed for replay. |
| Invalid/stale country, reference or foreign owner | Validate authority first, then safe 400/403/404/409 codes in section 8. Return no secrets, evidence or raw DB/provider errors. Unknown internal failure stays existing generic 500 and rolls back. |

Proposed durable idempotency records: unique `(actor_id,operation_scope,key)`, request hash, response status/body, completion timestamp and 24-hour expiry; only normalized request/response metadata with approved retention, not raw provider data. UUID key max 128 characters; same key/different hash is 409 `idempotency_key_reused`. Serialize concurrent identical keys; wait boundedly or return 409 `request_in_progress` with Retry-After. Commit success record in the same DB transaction as mutation; transient failures before commit leave no completed success. Replays re-authenticate/re-authorize; they return the original result even if the candidate token subsequently expired, with no renewed promise of current selectability. After retention expires, uniqueness/terminal-state constraints still prevent duplicates; return reused/already decided as appropriate, not a guaranteed replay. Geo key storage must exist before promising this behavior. Existing C4 has no idempotency mechanism and is unchanged.

Lock order: actor/capability, idempotency scope, country advisory lock for registry writers, proposal if applicable, locality rows in UUID order. Template mutations instead take actor/capability, Template identity, then locality; registry writers never acquire Template locks. C4 keeps its existing source identity/version/review order and creates an unresolved Local without locality locks. Do not add reverse locality→Template scanning locks to correction; evaluate dependencies asynchronously/read-only. Bounded deadlock/serialization retries rerun full validation; exhausted attempts return 409 `concurrent_update`, never silently accept stale facts.

## 11. Acceptance-test matrix for future C6b

These are **planned tests, not executed implementation evidence**. Use disposable PostgreSQL plus HTTP contract tests for persistence/races; provider fixtures for deterministic errors, and separate licensed live-provider evidence before rollout.

| ID | Scenario | Expected evidence |
| --- | --- | --- |
| A01 | Fresh schema and upgrade from 023 | Additive relations/FKs/checks equivalent; migration rerun safe; fingerprints of legacy/Signal/version/review/Hunt data unchanged. No automatic classifications or mappings. |
| A02 | Country lookup | ISO syntax/membership, normalization, nonselectable historical codes, pagination and provider independence. No world-locality import. |
| A03 | Existing search/resolve | Country/context-qualified internal results, exact UUID/revision resolution without provider, no GET-created records, bounded pagination and safe projection. |
| A04 | Provider candidate type/context | Place accepted by approved mapping; POI/address/neighborhood, malformed coordinate, missing country/context and wrong country rejected. No arbitrary client IDs/coordinates. |
| A05 | Selection and reuse | Explicit licensed candidate creates exactly identity/revision/ref; subsequent exact reference reuses UUID. Same-name/different-region records distinguishable. |
| A06 | Ambiguity/duplicates | Different IDs/proximity/accent/name similarity produce candidates/manual review, not a merge. Exact ID with conflicting context fails. Known duplicate UUIDs retain history. |
| A07 | Race and rollback | Same-reference two connections yield one locality; different-ID/manual concurrent duplicates requery under country lock; injected insert failure leaves no orphan or completed idempotency result. |
| A08 | Provider failures | Timeout/429/invalid response/unsupported country/storage gate explicit; internal results still usable, no invented fallback, no persisted temporary result or leaked token/body logs. |
| A09 | Proposal authoring | Required context/evidence/coordinate bounds, only Creator's own reads/bindings, duplicate warning, pending/rejected never submittable. No automatic evidence crawling. |
| A10 | Proposal review | Independent Admin accepts new or proven existing identity atomically; self-acceptance denied, stale/repeated/conflicting decisions rejected; rollback and exact replay covered. |
| A11 | Draft integration | Null/omitted/inherited/explicit/proposal selection rules, exact version sidecar, stale inherited display; association failure rolls back whole save. No existing classified version UPDATE. |
| A12 | Local submission/approval | Existing geography completeness plus accepted active/current locality; missing/pending/rejected/stale/unavailable blocked at both stages. Exact inspected Template version required. Locality acceptance never implies Template approval. |
| A13 | Universal and C4/C5 | Universal without locality/GPS remains submittable; supplied localitySelection rejected; copy starts unresolved; old Locals unchanged through source revision/republication. C5 publication pin/locking remains intact. |
| A14 | Correction/unavailability race | Both transaction orders with actual blocked DB connections; old revision/approval immutable, stale candidate fails; provider outage alone does not deactivate identity. Approved Local correction remains gated by L06. |
| A15 | Legacy activation | New binding gate cannot be bypassed by absent sidecar; old pending Local requires new immutable version, approved old Local stays closed; legacy strings/read/submit/catalog and Signal byte stability preserved. |
| A16 | Auth/privacy | Persisted multi-role/revoked/guest/blocked/retired behavior, owner 404, professional read restrictions, no evidence/answers/owners on public registry projection, no SSRF or query/token logs. |
| A17 | Idempotency | Lost-response replay, concurrent same key, different-payload key reuse, expiry, role revocation on replay and post-commit locality lifecycle change. No changed historical response claimed as current selection. |
| A18 | Future G4/D10 boundary | Classified list/geography/direct Hunt selection remain closed throughout C6b; later rollout separately proves shared eligible resolver, country/locality/version mismatch rejection and atomic independent locality snapshot. |
| A19 | Later deployed provider/supply-chain proof | Record license/account policy and actual coverage cases, FE/BE deployed revisions and date; save/reopen/submit/review/eligible selection/snapshot after later corrections. CI or mocked results do not count as live verification. |

## 12. Explicit unresolved decisions requiring approval

The product requirements in section 2 are already supported by the master plan. The following technical/product-policy choices are **not approved by this documentation task**. Recommended defaults make the proposal reviewable; do not implement them simply because a recommendation exists.

| ID | Decision / recommendation | Approval required before |
| --- | --- | --- |
| L01 | Conditional Mapbox Geocoding v6 permanent adapter, entitlement, actual applicable terms/order, storage of IDs/normalized fields/immutable snapshots/backups, sharing/termination rights, attribution and budget. No entitlement confirmed. | Provider candidate retention or persistence; seek another reviewed provider if rights fail. |
| L02 | One primary Locality per Local version; provider type mapping (`place` default) and representative coordinates/context requirements. Cross-locality/border routes require explicit G4 policy. | Schema/API implementation and route eligibility rollout. |
| L03 | Normalized immutable locality revisions + version association sidecar, provider namespace uniqueness, country advisory serialization and no automated merges. | Additive schema/model PR. |
| L04 | New paths/errors, actor-bound 10-minute candidate references, no shared response cache, 24-hour durable idempotency, query/page/timeout/rate budgets. | API/adapter PRs; exact operational timeout/rate values must be fixed with account quota. |
| L05 | Creator proposals; independent Admin acceptance, evidence bounds and no URL crawling; acceptance requires a new Local version to bind. | Manual proposal implementation. |
| L06 | Activation gate for existing pending/approved unbound Locals; approved Local correction/revision authority, stale locality revision consequences for already-approved future selection, withdrawal/expiry and saved-Hunt publish/start policy. Preserve history and keep classified gates closed until settled. | Submission/approval activation and any G4/D10 eligibility opening. |
| L07 | Evidence and rejected/pending proposal retention/deletion, private review audit/actor retention and independent evidence rights. | Proposal data collection/production rollout. |
| L08 | Country reference dataset source/update license, selectable territory/worldview policy and historical code changes. No product territorial policy inferred from provider defaults. | Country reference implementation and live lookup. |
| L09 | Organizer internal-only lookup versus paid external requests; Admin correction/unavailability procedure and who may record provider aliases. Recommend narrowly privileged operations with reason, no generic geo admin platform. | Authorization/API implementation. |
| L10 | Later G4 evidence model, route/access/safety validity/blockers and consistent eligible Local resolver; D10 exact expected reference and Hunt locality snapshot fields. | Opening classified catalog or Hunt selection; remains a separate contract/slice. |

Do not reopen already merged C1–C5 category/provenance/publication/copy decisions in this review. No alternative third category, extra Universal release/consent gate, automatic extraction/classification or live inheritance is offered.

## 13. Proposed C6b implementation sequence

Each row is a separate small BE Draft PR targeting main after its dependencies/decisions are approved. Further split if review size requires it. FE, Participant runtime, merge and deployment are outside these PRs.

| Order | Focus and dependencies | Reviewable acceptance |
| --- | --- | --- |
| C6b-1 | Additive Country/Locality/revision/provider-ref foundation; approve L02/L03/L08 and license-compatible provenance fields. | Disposable 023 upgrade/fresh parity and A01; accepted UUID/revision/uniqueness/history invariants. No endpoints or selection activation. |
| C6b-2 | Internal country/locality lookup and exact resolution; approve read auth/projections L04/L09. | A02/A03/A16; provider-independent reads, legacy untouched. |
| C6b-3 | Licensed provider adapter/search/reference validation only; L01 coverage/rights/cost evidence plus L04 budgets. | A04/A08 and deterministic adapter tests; no persistence or browser-token reuse. If rights unresolved, stop this slice while internal work proceeds. |
| C6b-4 | On-demand resolve persistence and durable idempotency; depends on 1–3. | A05–A08/A17 with real PostgreSQL races/rollback; no bulk import or merge. |
| C6b-5 | Proposal persistence/owner submit/read; L05/L07 approved. Add its own tracked additive migration if needed. | A09/A16/A17; pending-only authoring, cannot bypass any Template gates. |
| C6b-6 | Independent Admin proposal queue/review and bounded canonical acceptance/correction procedure; depends on 1/5 and L09. | A06/A07/A10/A14; audit/duplicate/terminal decision transactions, no Template approval effect. |
| C6b-7 | Immutable Local-version association schema and progressive save/read envelope; L03 and compatibility portions of L06 approved. | A11/A13/A15; atomic insert with new version, no UPDATE/backfill or new approved Local revision path. |
| C6b-8 | Exact-version Local submission/Admin locality checks under explicit activation plan; depends on 6/7 and L06. | A12–A16; old pending handling/correction path proven, legacy preserved, classified Organizer gates still closed. |

Recommended next step: review C6a decisions first, then C6b-1 only. Parallel provider entitlement/coverage investigation may inform C6b-3 but is not authorization to store data. A separate G4 contract must settle L06/L10 evidence/validity/withdrawal and eligible resolver, followed by separately reviewed catalog/Hunt-selection changes and D10 FE integration. Full deployed F7 → G4 → D10 proof remains the gate before Participant runtime under the approved full sequence; the audit's optional pilot shortcut is not silently adopted.

## 14. Documentation verification and limits

For this documentation-only change, check the sole changed path, Markdown headings/tables/fences, parse JSON examples, resolve BE relative links against the inspected main tree, reconcile C1–C5 terminology and verify that every new API/schema rule is labeled proposed. Verify Draft PR target `main`, draft state and one-file diff. No application tests/build/migration/provider live calls or deployed E2E are warranted or claimed. The matrix above defines future acceptance; historical C1–C5 reported test counts remain historical evidence in their own documents.

Local documentation checks on 28 October 2026 passed: eight JSON blocks parsed; all BE relative link targets exist in the pinned main tree; headings 1–14, acceptance/decision IDs, balanced fences and trailing-whitespace checks passed. `git diff --no-index --check` emitted no whitespace diagnostics (exit 1 represents the added-file difference). Both remote main SHAs were rechecked unchanged before branch creation. External source URLs were researched as described in section 5; no claim of a rendered Markdown/browser or live-provider verification is made.
