# F7 Backend Template contract proposal

**Status: D04 PO APPROVED — 2026-10-27; all other unresolved decisions PROPOSED — NOT APPROVED. Documentation only.**

Prepared 27 October 2026 for Product Owner review. The Product Owner superseded the earlier implementation request with this contract-definition task. No migration, model, endpoint, authorization, UI or deployed behavior is changed. D04 records an approved product rule; other recommendations and example payloads remain proposals, not available APIs or permission to implement them. Review of this document does not itself approve any unresolved decision; record each decision explicitly in section 10 before implementation.

The approved sequence is **F7 → G4 → D10 before Participant runtime**, with no controlled-pilot sequencing exception. This document completes none of those workstreams. Merge and deployment are not authorized by this task.

## 1. Evidence and architectural authority

The inventory describes Backend `main` at [`4fea7c31375a5ce9a7899c0fc6f009eb42949298`](https://github.com/tedixdev-arch/Tedix_Hunt_BE/tree/4fea7c31375a5ce9a7899c0fc6f009eb42949298). References below are relative repository files, inspected at that revision. They are code evidence, not deployed verification.

Read together with:

- [FE architecture implementation plan](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/main/docs/TedixHunt_Prototype_Architecture_Implementation_Plan.md): F1 hierarchy and agreed category target; F7; G4; D10; especially [section 14](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/main/docs/TedixHunt_Prototype_Architecture_Implementation_Plan.md#14-template-lifecycle-contract) and [section 20.2](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/main/docs/TedixHunt_Prototype_Architecture_Implementation_Plan.md#202-staged-workstreams-before-participant-runtime). Inspected file blob: `5aab1a71632a274377a3c6fc30d293dc649ed17c`.
- [FE architecture audit and critical path](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/main/docs/TedixHunt_Architecture_Audit_and_Critical_Path_v1.md): D01–D07 security priorities, P1 sequencing and P11 full category design. Inspected file blob: `45aeebe64e43aa63c3f9d7ea771b5486ca2b7172`. The PO's full-sequence decision governs over the audit's possible pilot alternative.
- [BE PR #73 / D05](https://github.com/tedixdev-arch/Tedix_Hunt_BE/pull/73) and [PR #74 / D07](https://github.com/tedixdev-arch/Tedix_Hunt_BE/pull/74) are included in the inspected main. Current code has independent self-approval prevention and review records; older FE statements calling those absent must not override actual BE evidence.

Master Implementation Control Plan v3 was named in the superseded request but was not supplied or found in the inspected repository references. This proposal does not claim to have reviewed it. Reconcile it, if supplied, before approving implementation slices.

PR #74 is merged. Its documented release gate requires authorized operator verification of securely generated, stable JWT configuration in migration and service contexts. This task does not verify live configuration, rotate credentials or waive that gate. No unmerged security changes are dependencies of this proposal.

## 2. Existing Backend contract inventory — observed, not proposed

| Area | Actual main behavior and constraints | Evidence / boundary |
| --- | --- | --- |
| Template identity | `hunt_templates`: UUID PK, globally unique text `key`, `origin` (`platform`/`creator`), nullable Creator attribution with restrictive user FK, status and timestamps. Creator origin requires a Creator ID. No category or source-copy eligibility exists. | [schema](../src/db/schema.sql), migration 016. Origin is not Universal/Local classification. |
| Immutable authoring versions | `hunt_template_versions`: UUID, Template FK, positive integer version, JSONB content, origin/Creator attribution, unique `(template_id, version)`. Creator save inserts a complete new version under an identity `FOR UPDATE` lock; no editing an old row through the API. | [HuntTemplate model](../src/models/HuntTemplate.ts). Application immutability is stronger than SQL: the schema has no general trigger denying content UPDATE; direct internal helpers do not provide the same authoring validation as routes. |
| Creation / ownership | Generic Creator POST creates identity plus version 1 in one transaction. Owner reads filter `origin='creator'` and `created_by_user_id` in SQL. Other-owned/platform/absent authoring identities share 404. Keys normalize to lowercase hyphenated alphanumerics, max 100. | [Creator routes/OpenAPI](../src/routes/creatorTemplates.ts), [validation](../src/domain/creatorTemplates.ts). New-version content must carry the expected next key/version; server allocates the number. |
| Capability authority | Authentication reloads user and persisted roles; blocked/retired accounts get 401. Guests cannot use privileged roles. `user_roles` is authoritative, including combined capabilities; `users.role` and JWT role claims do not grant Creator rights. | [auth middleware](../src/middleware/auth.ts), [User](../src/models/User.ts), schema. Admin-only or Organizer-only is not Creator authorization. |
| Lifecycle / submission | `draft`, `submitted`, `changes_requested`, `approved`. Submission locks identity, requires latest requested version and validates completeness, then pins `submitted_version`. Deferred composite FK binds the pin to that identity's version. | Model, schema, migrations 018–020. Only `draft` is editable/submittable today. `changes_requested` can be read/deleted subject to dependencies, but revision/resubmission is not implemented. No Template `rejected`, `retired`, expiry or approval-withdrawal state exists. |
| Review | Admin queue/detail resolves exact pin. Approve/request-changes locks identity and atomically changes status and inserts `(template_id, version, reviewer_user_id, decision, decided_at)`. One review row per version; review FK restricts version deletion. Self-approval is forbidden; self-request-changes remains allowed. | [Admin routes/OpenAPI](../src/routes/adminTemplateReviews.ts), model, migration 021. This is a minimal decision record, not full audit/re-review history. Historical approvals were deliberately not backfilled with invented reviewers. |
| Approved resolution | Creator identity must be approved and resolves its `submitted_version`, never an arbitrary latest version. Approved platform identity resolves latest saved version. | `listApprovedWithLatestVersion` / `findApprovedByKeyWithLatestVersion` in model. No category filter; no community reuse catalog. |
| Professional disclosure | `GET /api/hunt-templates` requires active non-guest Creator, Organizer or Admin and returns key/version/displayName/theme. `GET /api/hunt-templates/{key}/geography` resolves current approved artifact anew, accepts no version override and allowlists saved geographic fields at every level. | [catalog routes](../src/routes/huntTemplates.ts), [projection](../src/domain/huntTemplates.ts). No gameplay, answers, scoring or review notes in these responses; Participant-only/guest denied. Missing legacy fields remain missing; malformed present geography returns 409. |
| Geography / validation | Drafts allow progressive coordinates. `normalCheckpointCount` is 1–20; normal positions are uniquely numbered within it, names nonblank ≤100, finite valid lat/lon and radius 5–500 m. A supplied FinishPoint is complete with integer radius. Geographic submission needs every position, a FinishPoint and N numbered normal gameplay entries plus one terminal entry. | Creator validation and [schemas](../src/lib/swagger.ts). Normal position radius currently accepts finite numbers, not only integers. The pre-geography compatibility branch accepts content without count/positions. No canonical Country/Locality UUID, provider identity, route evidence or safety certification exists. |
| Hunt selection / persistence | Draft Hunt PATCH accepts a key, resolves approved content once, and saves key/version/complete JSONB content together. Client cannot provide version/snapshot through that route. Unrelated draft edits do not refresh it; explicit reselection can replace a draft's snapshot. Non-draft setup edits are rejected. | [Hunt routes](../src/routes/hunts.ts), [Hunt model](../src/models/Hunt.ts). Snapshot fields are not Template FKs. Immutability means independence from future source changes, not a SQL trigger forbidding every Hunt draft replacement. |
| Hunt readiness | Readiness validates persisted key/version/snapshot consistency, basic metadata/checkpoints, setup and supported pilot settings. `country`/`region`/`city` are strings; country/city are required by readiness. | [readiness](../src/domain/huntReadiness.ts). No canonical locality, category/evidence/validity checks or continuous current-approval revalidation. Do not claim G4 publish safety is implemented. |
| Deletion / account retirement | Unused Creator draft/changes-requested deletion is transactional; checks Hunt key/snapshot references while serializing Hunt writes. Protected references block deletion. Template/review attribution protects user history; removal anonymizes dependent identities and removes roles/credentials instead of deleting history. | Template and User models. Retiring an account does not itself change Template approval; visible names/email may be anonymized, durable identity remains. |
| Signal and starters | Migration 017 installs approved platform `signal-cluj-napoca` v1 with checkpoint digest verification and plain inserts. Fixed Creator starter registry lists Signal and Overload; factories create independent ordinary drafts. Signal uses frozen fixture and research metadata; Overload is not seeded/approved by a migration. | [Signal migration](../src/db/migrations/017_signal_cluj_napoca_v1.ts), [starter docs](creator-starter-catalog.md), [Signal starter](signal-cluj-creator-starter.md), [Overload](signal-overload-cluj-napoca.md). `starterSource` is not community Universal provenance or evidence of category/reuse approval. |
| Migrations / documentation | Numbered compiled migration discovery, advisory lock, per-migration transaction and applied-history checks; schema baseline mirrors current structures. OpenAPI is inline route annotations plus shared Swagger schemas. | [migration runner](../src/db/migrate.ts), [discovery](../src/db/migrations/index.ts), Swagger. Existing migrations remain immutable history. |

This is a source/consumer inventory, not a live database census. Actual numbers of legacy identities, versions, approvals and Hunt references must be collected read-only before rollout with appropriate access; no live data was read here.

## 3. Established requirements versus decisions

The following are established by the FE target architecture and the PO's current direction, although new category behavior is not implemented:

1. A Template is content/configuration assembled with the Creator Framework; Mechanics Library is neither a Template nor a second gameplay engine.
2. Universal content is reusable without a required city or fixed coordinates; Universal approval does not certify a physical route. Local adds locality, geography, adaptations and independently reviewed operational evidence.
3. Active approved Creator capability may author/submit both categories. Under the PO-approved D04 rule, an independently Admin-approved and published Universal Template version is automatically reusable by all active authorized Creators, including other Creators. No separate Creator consent or Admin community-release permission is required. Local may start from scratch or copy that exact authoritative source version; the Local belongs to the copying Creator and requires independent Local approval before Organizer selection. Source ownership never grants destination editing rights.
4. Copy on creation creates a new destination identity/history and content snapshot, retaining exact source provenance. No live inheritance, automatic source updates or inherited Local approval.
5. Submission and independent Admin approval bind exact immutable versions. Universal approval cannot authorize Organizer selection. Future ordinary location-based selection requires approved eligible Local versions after explicit legacy transition.
6. Historical Signal versions, review decisions and Hunt snapshots survive unchanged. No automatic classification from name, city, coordinates, fixture or old approval. No invented geographic verification.
7. Protected coordinates/content must respect authorized audiences. G4 category/evidence gates and D10 setup remain later work; all new classified artifacts stay out of Organizer selection until those gates exist.

**D04 is PO APPROVED — 2026-10-27. All other unresolved representation, rollout and behavior decisions in sections 4–10 remain PROPOSED — NOT APPROVED.** The register records alternatives, recommendations and gates; it does not turn an established product principle into an approved technical design.

## 4. Proposed classification and ownership contract

### 4.1 Category storage and version binding (D01)

Alternatives:

- A: mutable identity category only. Simple, but relabeling an identity can reinterpret already approved versions; unsuitable without version binding.
- B: category only in immutable content/version. Each version is explicit, but one identity could switch between Universal and Local and complicate approval/catalog authority.
- C (recommended): immutable category on new identity, repeated/bound on every version with database-enforced consistency; absent classification means historical/unclassified only. Expose it in an API envelope rather than rewriting old JSONB.

Under C, a classified identity's category is `universal` or `local` for its lifetime. Every version carries that same category and category-validation contract revision. Category changes require a new identity, not a version that changes meaning. Existing rows remain NULL/unclassified; no historical JSONB, approval or snapshot changes. Use `legacy_unclassified` only as a read representation, not a third authorable category. Exact-version review must resolve the version-bound value and reject inconsistencies.

Use the same content/mechanic framework for both categories. Recommended Universal v1 validation: reusable normal/terminal structure may exist without checkpoint positions, FinishPoint coordinates or canonical locality; reject authoritative physical-route fields in the classified Universal contract. Local drafts may be incomplete; Local submission must eventually satisfy separate identity/geography/evidence gates. Free-text stories can mention places; field validation cannot certify narrative reusability. Unknown extension fields must not become an alternative geographic authority. Exact allowed fields and supported mechanic constraints need a reviewed validation matrix before implementation (D02).

The old validation compatibility branch remains a legacy behavior; it must not let a classified Local bypass required geography or force Universal submission to include GPS. No historical scoring/role/content normalization follows from category validation.

### 4.2 Ownership and cross-Creator authorization (D03)

Alternatives: original-author-owned derivatives; platform-owned community derivatives; independent destination ownership. Recommend independent ownership: destination `origin='creator'` and `created_by_user_id=authenticated Creator`, source attribution recorded separately. Ownership transfer is outside V1. Admin capability alone cannot create a Creator-owned artifact; Admin/Creator combined identities obey Creator ownership and independent approval.

Reuse authorization requires active non-guest persisted Creator capability at commit plus a source-specific eligibility check. Knowing a source key/version/Creator ID conveys no permission. Authorization must run before private-source lookup/disclosure; absent/private/other-owned authoring reads retain indistinguishable errors. Owner authoring read of one's own Universal is distinct from community-copy access.

Recommend locking/rechecking destination actor account and Creator capability within the copy transaction, following compatible lock order with role removal/account retirement. Source approval/availability must also serialize with copy. The implementation design must demonstrate this ordering rather than assume route middleware alone closes revocation races.

## 5. Proposed source eligibility, copy and provenance

### 5.1 Exact source eligibility (D04–D05)

**D04 — PO APPROVED — 2026-10-27.** Source: the Product Owner's explicit instruction in this conversation to update Draft PR #75 on 27 October 2026:

> An independently Admin-approved and published Universal Template version is automatically reusable by all active authorized Creators.

This approved rule replaces the earlier consent/release recommendation. Community reuse derives from the authoritative approved/published Universal version itself; there is no separate Creator opt-in, Admin community-release mechanism, per-Creator allowlist or reuse-grant record/API. A copied Local belongs to the copying Creator and requires its own independent Local approval before Organizer selection. Exact-version provenance, historical versions and existing Hunt snapshots remain preserved; no retroactive restrictions or automatic source updates are introduced.

Recommended transaction predicate implementing that approved product rule (representation and locking details remain proposed):

```text
active authorized destination Creator
AND exact source version is authoritatively classified Universal
AND exact source version is independently Admin-approved and published
AND approval/publication and source artifact refer to the same immutable version
```

A draft, submitted, changes-requested, unapproved, unpublished, wrong-category or unclassified artifact fails. Resolve approval/publication server-side; a client-supplied version is a precondition, never proof of eligibility. A newer saved version must not substitute for the exact approved/published artifact, and a stale expected version is rejected rather than silently copying a different artifact. Missing authoritative evidence fails closed for new classified copying; never manufacture evidence or impose new review requirements on historical versions or existing Hunt snapshots.

**Still unresolved under D05/D09:** current main has no separate Template `published` state; generic approval currently makes the pinned version catalog-selectable. The representation of authoritative publication for classified Universal versions must be reviewed, without inventing a separate community-release permission. The publication model must specify whether one or multiple versions may remain authoritatively published. Recommend exact authoritative version resolution with no latest-version inference. Every version that remains independently approved and published must be reusable under D04; a current-pin-only resolver cannot exclude another still-published version. Publication transitions need PO review, and cannot add consent or release gates.

Account blocking/retirement/role loss of the original Creator must not become an automatic extra copy restriction while that source version remains authoritatively approved/published. Whether and how a future explicit withdrawal/unpublication changes authoritative publication, and its effective-time policy, remain PROPOSED — NOT APPROVED under D05; this document does not adopt such changes. Any future policy must preserve prior copies, provenance, historical versions and Hunt snapshots, with no retroactive restrictions or content mutation. Source edits and new approvals never automatically update an existing Local. Broader legal/takedown and legacy rollout policies remain separate unresolved decisions (D05/D12).

### 5.2 Local creation paths (D06)

**Scratch:** Creator supplies explicit Local category and ordinary draft content. Allocate a fresh identity/key and version 1 atomically. Source provenance is null; no Universal source is required. Local draft may omit unresearched geography; it is not approved, selectable or certified.

**Copy:** Creator selects an offered exact approved Universal version. Backend independently resolves the exact immutable version and its authoritative approval/publication evidence, then snapshots its content into a fresh Local identity, version 1 and immutable lineage. Rewrite only destination `key`/`version`; preserve reusable source content and do not invent locality, coordinates, safety evidence or approval. Local-specific adaptation is authored in subsequent versions. If target schema requires a mapping, define and version that mapping explicitly; no silent stripping of gameplay or claim of a byte-identical copy after adaptation.

Recommend a server-generated destination UUID-based key when omitted, or existing normalized caller key rules when supplied. No caller-supplied destination UUID/owner/status/provenance/source content. Every completed request with a different key creates an independent copy. For a same-key retry/concurrent request, one creation succeeds and others receive 409 without overwrite; owner GET resolves uncertain responses. Alternative: durable actor-scoped idempotency tokens, separately designed if PO requires replay to return the same result. This proposal recommends existing key-based behavior, not an unimplemented idempotency promise.

### 5.3 Version-bound lineage and transaction (D07)

Alternatives: content JSON only; normalized exact source FK with Creator join; normalized FK plus immutable attribution identifiers and source evidence. Recommend the last, with no copied personal profile values:

| Proposed lineage field | Meaning |
| --- | --- |
| Destination Template / first version identity | The newly owned Local identity and its version 1; later versions inherit unchanged lineage. |
| Source Template UUID and key at copy | Stable source identity plus historical human-readable key; not a mutable live-content reference. |
| Source version row UUID and integer | Exact immutable artifact, bound together by FK/unique constraints; never a latest-version shortcut. |
| Original Creator user UUID | Source ownership/attribution identifier, validated against authoritative source records; not the copying actor. |
| Approval / publication evidence reference | Exact authoritative independent approval/publication used at copy time, bound to the source version; later state changes never rewrite this historical fact or prior copies. |
| Copied time and mapping revision | Server timestamp and documented copy transformation contract revision. |

Recommend no immutable source name/email snapshot: keep durable UUID attribution and resolve an audience-safe display label which can become `Deleted user` on retirement. Alternative: frozen public alias with approved retention/redaction rules. Original authorship survives anonymization; public disclosure of internal user UUIDs is a separate D08 decision. Owner/Admin may receive audit identifiers; community listings should use an approved public attribution projection without email.

Proposed transaction: check/lock actor authority → lock source identity/effective eligibility records → resolve and verify exact immutable artifact/category/independent approval/publication → allocate destination identity → insert copied version 1 → insert lineage → validate deferred constraints → commit. Any error rolls back all destination rows. All state-changing eligibility paths must use a compatible locking protocol. Do not hold an open transaction during provider calls. Concurrent requests using distinct destination keys can both succeed; same-key conflict must not leave an orphan identity/version/lineage.

Lineage is write-once and version-bound, not an editable content property. Later Local versions retain it, even if all narrative is adapted. Recommend a restrictive source-version FK so a surviving derivative protects source identity/version deletion; deleting an unused destination draft removes its own lineage without deleting the source. Mutating source content, category, owner or lineage must be denied in persistence, including internal helper paths. Newer source edits, approvals, retirement or later publication changes never mutate copies or retroactively restrict them. Update-from-source is outside V1.

## 6. Proposed lifecycle, approval and visibility boundaries

### 6.1 Category review and staged gates (D09)

Extend the existing review workflow; do not build a second approval engine. Universal review checks reusable structure/content/supported mechanics; it grants no route approval. Local review independently checks Country/Locality, exact ordered route, all normal stops and FinishPoint, adaptations, access and operational evidence. Advisories, evidence-required exceptions and unresolved blockers follow F7/G4; warnings or provider estimates are not certification.

Recommend classified drafts/versioning may ship in an approved F7 foundation slice, while classified submission/approval fails closed until its category validation/review contract exists. Alternative: permit category submission into a clearly identified held queue with approval disabled; this adds a new queue state/UX contract. Do not let the existing generic approve endpoint accidentally release classified artifacts before category gates. This staged choice needs explicit PO approval, even though keeping new categories out of Organizer selection is already required.

After category governance exists, an independently Admin-approved and published Universal version is automatically reusable by all active authorized Creators under D04. Local Organizer eligibility remains a separate decision requiring independent Local approval and the applicable G4 gates. No source approval is copied to the Local destination. Independent reviewer must differ from destination Creator even for combined Admin/Creator accounts. Universal source authorship does not confer Local editing/review authority.

### 6.2 Revision and repeated review (D10)

Current main cannot revise/resubmit changes-requested content or edit approved identities. Alternatives: keep V1 restrictions; add a transactionally versioned revision loop; create a replacement identity per revision. Recommend retain restrictions in the first foundation slice, then implement changes-requested revision in a separate approved slice before a complete Creator workflow is claimed.

That slice must specify how the old reviewed pin remains auditable while a new draft exists (current `draft` requires a null pin), and preserve one exact review per new version. Post-approval editing needs separate authoring-versus-effective-approval state if previous approval remains usable. Do not reinterpret current `status` or overwrite review PKs to support it. Same-version re-review/reversal requires append-only decision history and an effective-approval pointer, separately designed with G4. Tests simulating later source versions must use that approved workflow or controlled fixtures, not invent an API that edits approved content.

### 6.3 Organizer and geography boundaries (D11)

Recommend a single authoritative selection predicate shared by metadata listing, geography inspection and exact-key Hunt selection. In the first classified foundation it permits only the approved legacy compatibility population chosen in section 7; no Universal or new Local is selectable. Later it additionally permits exact approved Local versions satisfying G4 identity/evidence/validity and rollout gates. Client-side filtering is insufficient.

Community Universal discovery is a separate Creator-only purpose, not an expansion of the professional Organizer catalog. Creator owner reads/Admin reviews can expose their authorized content; community browse should initially expose metadata and approved attribution only. Full source reuse is performed server-side; any later full-content community preview needs its own disclosure decision (D08).

Future Local eligibility must be checked atomically with Hunt selection/persistence and with applicable publish readiness. Expected key/version should reject stale selection instead of switching to a newer version between preview and save. These are future G4/D10 contract changes, not a claim that current key-only selection already protects that race. Existing authorized geography projections remain allowlisted; new category/provenance fields cannot leak private drafts, clues, answers, evidence or hidden coordinates to unapproved audiences.

## 7. Proposed legacy compatibility and rollout (D12)

Alternatives:

- A: retain every unclassified identity's present and future legacy behavior indefinitely. Easiest compatibility, but ongoing unclassified creation/approval could bypass category gates.
- B (recommended): explicit frozen legacy compatibility cohort at an approved cutover, preserving historical readable data and approved selection behavior, while new classified artifacts use gated paths. Handle other legacy authoring/review records through a reviewed transition inventory.
- C: hide all unclassified entries immediately. Violates section 14's requirement not to silently remove the catalog or strand Hunts; do not adopt without a separately approved transition.

Recommended phased policy, **not approved**:

1. Before cutover, inventory identities, exact versions, origin, status/pins/reviews, starter consumers, approved catalog/geography behavior and all Hunt key/version/snapshot references. Store baseline fingerprints and consumer expectations; do not print hidden content into public PR logs.
2. Add nullable classification and separate new metadata without backfilling or rewriting old rows. Until a cohort policy and client transition are approved, do not enable classified production writes or legacy catalog filtering. Schema expansion alone must preserve existing reads.
3. At a PO-approved cutover, explicitly record the legacy selection cohort of currently approved identities and exact effective versions. Preserve today's selected artifacts; platform latest-resolution is recorded explicitly rather than inferred forever. This freezes future legacy selection, so it is a behavior change requiring approval, not an existing guarantee.
4. Existing unclassified drafts/submissions/changes-requested records remain owner/Admin readable and deletable only under current protection rules. Recommend no new legacy submission/approval at cutover; continue authoring only under a reviewed transition or create a separately classified adapted identity. Alternative: explicitly grandfather named in-flight records through their existing workflow. PO must select and record that exception set; never silently strand submitted work.
5. Generic creation should require explicit category after reviewed client readiness. Existing starter routes need a separate decision: retain a bounded legacy authoring exception, disable creation with a documented transition, or release separately reviewed classified starter adaptations. Recommend reviewed Local adaptations when ready, and no silent category assignment. If that work is not ready, defer the cutover rather than silently change starter semantics.
6. Historical identity/version/content/approval/review remains unchanged. A classified adaptation is a new identity/version with explicit adaptation lineage distinct from community Universal provenance; an unclassified source is never eligible for the Universal copy endpoint. Its prior approval does not transfer. Design that adaptation route only after approval, not by overloading category PATCH.
7. Existing Hunts continue reading their saved snapshots even if a Template leaves future selection. Unrelated Hunt edits/reopening do not refresh or reclassify it. D10 must separately decide reselection and publication eligibility for legacy draft Hunts; do not introduce a new gate that strands them by accident. Runtime incident/takedown policy is separate from snapshot rewriting.

Section 14 establishes preservation, not a final cohort or exemption policy. Steps 3–5 and legacy draft-Hunt publication rules are PO decisions. No deployment switch should infer approval from this recommendation.

## 8. Proposed API, constraints and migration strategy

### 8.1 Contract surface (D13) — names and payloads are proposals

Extend existing authoring envelopes/routes and shared OpenAPI conventions. Do not expose a parallel authoring service. A proposed classified read envelope adds `category`, `categoryContractVersion` and server-owned `sourceProvenance` to existing key/version/status/origin/submittedVersion/content. Historical reads return an explicit unclassified representation with null new metadata without modifying content. Copy lineage is null for scratch creation; field names and public attribution shape depend on D07/D08.

| Proposed operation | Request / response | Authorization and failures |
| --- | --- | --- |
| Extend `POST /api/creator/templates` | Required explicit `category: universal/local`, existing `key` and v1 `content`. Returns owned draft/version 1 plus authoritative category and null source provenance. | Active Creator only; 400 invalid/category-content conflict, 409 existing key. Reject client owner/approval/provenance fields, not silently trust or persist them. Legacy client transition requires D12. |
| Existing owner GET/list/version POST | Return version-bound category/lineage. New-version body remains complete `content`; owner/category/source lineage cannot be changed. | Existing indistinguishable 404 for absent/other-owned; 409 lifecycle conflict; 400 invalid content. Category mismatch fails rather than reclassification. |
| New `GET /api/creator/templates/community/universal` | Eligible exact-source metadata: source key/version, displayName/theme and approved public Creator attribution; no private content/geography. | Active Creator only; filtered by the same effective source predicate as copy. Empty list is valid. Existing `/:key` routes must not swallow reserved paths. Pagination/limits must be documented before enabling a growing catalog. |
| New `POST /api/creator/templates/{sourceKey}/copy-local` | Body `{expectedSourceVersion: 3, key: "my-local-copy"}`; key optional if using generation. Returns independent Local draft/version 1 and source provenance, never source approval. | Active Creator. Resolve source server-side; client version is an optimistic precondition, never eligibility proof. 404 for inaccessible/missing/noneligible source without private-state disclosure; 409 `source_version_conflict` only for otherwise visible eligible stale source, or `template_key_conflict`; 400 malformed/extra fields. |
| Existing `POST /{key}/submit` | Still pins explicitly supplied latest version; category-specific rules apply only when that category gate is available. | Owner only; 409 proposed `template_category_gate_unavailable` while staged closed; existing validation/lifecycle failures preserved. |
| Existing Admin review/approve/request-changes | Add category/exact provenance to authorized review projections; category-specific validation, same workflow. Resolve authoritative independent approval/publication for the exact Universal version; reuse is automatic under approved D04. No separate consent/release API. | Independent Admin approval. Recommended staged classified approval 409 until category review is supported. Publication representation and later state transitions remain D05/D09 proposals; the old generic response is not proof of a classified publication contract. |
| Existing professional catalog/geography/Hunt PATCH | Preserve current safe response fields and explicit legacy behavior in initial rollout; block classified selection at shared resolver. Later Local eligibility and expected-version selection need reviewed G4/D10 additions. | No new access from category metadata. All selection entry points must reject direct-key bypass. No new API implemented here. |

Illustrative copy request and abbreviated response, **PROPOSED — NOT APPROVED** (content is the ordinary complete snapshot, omitted here):

```json
{
  "expectedSourceVersion": 3,
  "key": "creator-b-local-journey"
}
```

```json
{
  "key": "creator-b-local-journey",
  "version": 1,
  "status": "draft",
  "origin": "creator",
  "category": "local",
  "categoryContractVersion": 1,
  "submittedVersion": null,
  "sourceProvenance": {
    "sourceTemplateId": "11111111-1111-4111-8111-111111111111",
    "sourceKey": "creator-a-universal-journey",
    "sourceVersionId": "22222222-2222-4222-8222-222222222222",
    "sourceVersion": 3,
    "originalCreatorId": "33333333-3333-4333-8333-333333333333",
    "copyContractVersion": 1
  }
}
```

Actual full response must include complete `content` and the approved server-owned evidence/time fields. Invalid source Creator/version fields in a request never override stored lineage. Exact error codes/additive fields need contract tests and OpenAPI examples before client integration; no error should reveal private source status or profile data.

### 8.2 Persistence constraints (D14)

Recommended additive design, subject to reviewed SQL/schema specifics:

- Nullable category/contract binding for legacy rows; new classified identity/version metadata must agree through composite constraints or validated triggers. Positive contract revision, Creator origin/owner consistency and a source-only-Universal / destination-only-Local invariant are checked in persistence as well as API validation.
- Normalized one-per-destination lineage with exact composite source-version references, original Creator consistency and restrictive source/user FKs; destination versions must bind unchanged lineage. Cross-table assertions require triggers or a normalized key structure, not a PostgreSQL CHECK subquery.
- Bind authoritative independent approval/publication evidence to the exact immutable Universal version. Derive community-copy eligibility directly from that authority; do not add consent/release tables, reuse-grant flags or per-Creator permission records. Publication representation remains proposed under D05/D09. Preserve immutable copy-time evidence if authoritative publication later changes; no retroactive restrictions on prior copies.
- Unique keys and `(template_id, version)` remain authoritative. Add immutable-column protection for new classified identities, version content/category/ownership and lineage; review insertion remains atomic. Audit whether legacy direct-write paths exist before applying triggers globally; protection must not rewrite old data or break controlled migrations/deletion.
- Existing protected draft deletion, review references and account retirement must account for new lineage/approval/publication references. A source cannot be deleted while a surviving derivative needs it. Locking must avoid deadlocks with identity/version creation, review, account/role mutation and Hunt updates.
- Preserve old enum meanings and submitted-version FK. Do not add rejected/retired/re-review meanings without separately approved lifecycle design. No global NOT NULL category constraint on historical rows.

### 8.3 Migration / activation / rollback strategy (D15)

Use new numbered additive migrations after the current 001–021 history; never edit migration 017 or backfill 021 reviewer evidence. Keep baseline schema consistent. First inventory and dry-run against a disposable baseline plus representative legacy fixtures. Migrations run through existing advisory-lock/per-migration transactions and must roll back without half-created metadata.

Deploy expand-first only after PO approval: compatible reads → nullable schema/constraints → reviewed model/API with classified activation disabled → category approval/publication governance → approved legacy cutover → later G4 eligibility and D10 selection. Avoid enabling a new writer before every resolver and old client path is safe. Any flag/configuration must be explicit, default closed for new classified selection and covered by tests; it is not a policy approval mechanism.

Migration checks compare historical content JSONB values, version/identity IDs, review records, approved pins and Hunt snapshots/selection results before and after. Do not backfill source attribution for starter copies from unverified guesses. Do not promote Signal to Local because coordinates or a city name exist.

Rollback recommendation: disable new classified writes/community exposure and keep selection closed; retain stored classification/provenance and readable derived drafts. Once real copies exist, do not drop lineage tables/columns or deploy a resolver that would expose their approved identities generically. A schema down-migration that deletes provenance is not an acceptable production rollback; use forward correction. Operator-reviewed deployment remains separate from review/merge and requires existing security gates.

## 9. Compatibility risks and acceptance criteria

### 9.1 Risks to prove, not assume away

| Risk | Required evidence / mitigation |
| --- | --- |
| Signal platform approval has no Creator review pin and resolves latest | Preserve exact current legacy selection under approved transition; never apply Creator-review requirements retroactively or invent approval evidence. Record platform version policy at cutover. |
| Signal/Overload starter metadata mistaken for Universal lineage | Preserve fixtures, checksum, existing created versions and `starterSource`; a separately reviewed adaptation records its actual source type. No automatic classification or pretend Universal approval. |
| Current generic Admin approval exposes all approved identities | Classified submission/approval and all catalog/geography/selection resolvers must be staged closed consistently, including direct-key Hunt PATCH and combined-role callers. |
| Legacy JSONB contains fictional navigation, partial/absent geography or old scoring | Do not reinterpret or normalize old content. New Local validation must not certify old story coordinates; newly adapted versions need independent evidence/review. |
| Account anonymization versus immutable attribution | Preserve UUID lineage and existing retirement semantics without retaining profile PII by accident; explicitly approve any public attribution/retention change. |
| New source FKs conflict with draft deletion or retirement | Test protected deletion and all dependent references; no orphan provenance, accidental source cascade or loss of historical review evidence. |
| New version/review functionality silently changes current lifecycle | Separate revision design and tests; no arbitrary approved-content editing, stale pin substitution or overwriting review history. |
| Locality/catalog cutover strands legacy consumers | Inventory clients/in-flight authoring/Hunts; explicit cohort/client transition and separate publication policy. No name-based locality mapping or global legacy filter. |
| Source withdrawal/expiry or stale preview races selection | Serialize eligibility with copy/save; define effective-time/validity policy before G4 selection. Snapshots remain data; operational availability is separate authority. |

### 9.2 Testable acceptance plan — not executed tests

Each implementation slice needs real disposable PostgreSQL integration coverage for transactions, FK/check/trigger behavior and concurrency; mock-only tests are insufficient. Run migrations, existing regression suites, typecheck and build for code slices; report actual execution and skipped suites. Do not target a persistent database with destructive tests.

| ID | Test / expected assertion | Dependency |
| --- | --- | --- |
| A01 | Creator-only authoring/copy with active persisted role; Admin-only, Organizer-only, guest, Participant, blocked, retired and revoked Creator denied; mixed-role ownership still enforced. Test revocation racing commit. | D03 |
| A02 | Universal scratch/versioning without GPS succeeds under approved contract; authoritative route/locality fields fail; category changes/metadata forgery fail at API and SQL/internal-helper boundaries. Prior versions unchanged. | D01–D02, D14 |
| A03 | Local scratch has new identity/v1 and null source; incomplete draft allowed; Local submit blocked until category gate, then incomplete geography/locality/evidence rejected as defined. | D02, D06, D09 |
| A04 | Cross-Creator eligible Universal copy uses exact authoritative independently approved/published version and actor as new owner, automatically available to every active authorized Creator without a separate permission, preserves reusable content with only documented mapping, new identity/v1 and full lineage. | D03–D08 |
| A05 | Draft/submitted/changes-requested/unapproved/unpublished/missing-authoritative-evidence/unclassified/Local/platform sources rejected. An independently approved/published Universal succeeds for every active authorized Creator without consent/release records. Stale expected version cannot silently substitute latest; arbitrary Creator/version/body content cannot bypass lookup. Future explicit publication withdrawal/rejection cases added only with approved state semantics; source account retirement alone is not an extra copy gate while the version remains approved/published. | D04–D05 |
| A06 | Independent Local edit produces v2; source edits/new versions/approval, publication changes or account retirement never change or retroactively restrict destination v1/v2 or lineage. No inherited approval or editing rights. Use permitted lifecycle or explicit isolated fixtures for source changes. | D05, D07, D10 |
| A07 | Same destination-key concurrent copies: one complete success, one 409, zero orphans; distinct keys: independent successes. Inject failure after each destination write: full rollback. Race authoritative approval/publication transitions and source deletion with copy using documented locks; do not require or test a separate consent/release mechanism. | D06–D07, D14 |
| A08 | SQL updates to protected category, source identity/version/Creator, lineage and immutable content fail. Mismatched composite source evidence and destination category cannot persist. Source deletion restricted, destination draft deletion cleans only its lineage. | D01, D07, D14 |
| A09 | Exact submission pin and independent Admin review remain intact; self-approval denied, current self-request-changes behavior preserved unless separately approved. No fabricated legacy review rows; review/retirement regressions pass. | D09–D10 |
| A10 | Migration preserves canonical Signal digest/content/identity, every preexisting version/review/pin and representative Hunt snapshots. Both starter contracts and six-normal-plus-terminal content remain unchanged. Account anonymization preserves durable attribution without credential/profile leakage. | D07–D08, D12, D15 |
| A11 | Universal and new Local absent from Organizer/professional list, geography and direct-key selection until gates; Creator community visibility cannot authorize Organizer selection. Approved legacy cohort remains available exactly as decided. Unauthorized requests reveal neither source existence nor hidden geography. | D08–D09, D11–D12 |
| A12 | After G4: independently approved Local with valid canonical locality/evidence is eligible; missing evidence/blockers/expiry/withdrawal/stale selection rejected. Selection race either snapshots one authorized exact version or fails atomically; old Hunt snapshots never refresh automatically. | D09, D11, D16 |
| A13 | Legacy drafts/submissions/Hunt reopening/reselection/publish and client/starter transition match explicit cohort decisions. Unrelated draft edits preserve snapshot; categorized metadata cannot trigger geographic/classification backfills. | D12 |

Documentation review acceptance: all baseline claims trace to source; every choice has alternatives/recommendation/status; no proposed endpoint is described as shipped; PO decisions and implementation gates are explicit; changed-file list is Markdown only. This PR performs documentation checks only, not PostgreSQL execution or runtime verification.

## 10. Product Owner decision register

**D04 is PO APPROVED — 2026-10-27, citing the Product Owner instruction quoted in section 5.1. All other unresolved rows remain PROPOSED — NOT APPROVED.** No additional PO decision is inferred from D04, the approved F7 → G4 → D10 sequence or authorization to write this proposal. Record chosen option, scope/conditions, approver, date and review/issue link per row. A changed recommendation remains a proposal until that record exists. Blank approval fields mean blocked, not implicit consent.

| ID | Status | Decision / explicit alternatives | Recommended choice | Implementation gate |
| --- | --- | --- | --- | --- |
| D01 | **PROPOSED — NOT APPROVED** | Mutable identity-only category / version-only category / immutable identity plus exact version binding | Immutable identity + version binding; historical null; reclassification via new identity | Before schema/model |
| D02 | **PROPOSED — NOT APPROVED** | Universal allows physical-route fields / forbids authoritative geography; Local geographic rules and draft-versus-submit matrix | Universal has no authoritative route/locality; progressive Local drafts, strict separately defined Local submission; preserve legacy branch only for legacy | Before validator or submit changes |
| D03 | **PROPOSED — NOT APPROVED** | Derivative remains source-owned / platform-owned / independent Creator-owned; capability check timing | Independent destination owner; persisted active Creator, transactional recheck; no V1 ownership transfer | Before creation/copy |
| D04 | **PO APPROVED — 2026-10-27** | Community-copy authorization — Product Owner decision quoted in section 5.1; source: PO instruction to update PR #75 in this conversation, 2026-10-27 | An independently Admin-approved and published Universal Template version is automatically reusable by all active authorized Creators. No separate Creator consent or Admin community release. Exact source-version provenance; Local owned by copying Creator, independently approved before Organizer selection; preserve historical versions/snapshots, no retroactive restrictions or automatic updates | Product rule approved; technical representation and other dependent decisions remain proposed. Documentation only; no implementation/merge authorization |
| D05 | **PROPOSED — NOT APPROVED** | Authoritative publication representation, single versus multiple published versions; possible explicit future withdrawal/unpublication and timing | Resolve exact approved/published version; no latest-version inference, extra copy permission or source-account restriction while publication remains effective. Version availability and publication transitions require review; no retroactive restrictions | Before source resolver/publication-state design; cannot narrow approved D04 with a consent/release gate |
| D06 | **PROPOSED — NOT APPROVED** | Key-based retries / durable idempotency; copy transformation and scratch behavior | Independent scratch; copy maps only identity/version; unique optional key with one-winner 409 semantics | Before creation API |
| D07 | **PROPOSED — NOT APPROVED** | JSON-only provenance / exact FK / exact FK plus immutable source/approval/publication attribution; deletion/lineage inheritance | Normalized write-once lineage with restrictive exact source/evidence FKs, inherited unchanged; source cannot cascade-delete copies | Before schema/copy/deletion |
| D08 | **PROPOSED — NOT APPROVED** | Immutable personal display snapshot / durable UUID + current safe label; metadata-only / full community preview | UUID attribution internally, no frozen name/email; safe approved public label, metadata browse only; approve public identifier exposure separately | Before payload/retention changes |
| D09 | **PROPOSED — NOT APPROVED** | Generic classified review immediately / held submissions / staged closed until category governance | Classified authoring first; submission/approval closed until category rules; authoritative Universal approval/publication with automatic reuse under D04, independent Local approval | Before any classified review |
| D10 | **PROPOSED — NOT APPROVED** | Existing frozen lifecycle / revision loop / replacement identity; later same-version re-review design | Freeze first slice; separately design changes-requested revisions and authoring/effective-approval separation, append-only re-review if required | Before revision/new approval behavior |
| D11 | **PROPOSED — NOT APPROVED** | Separate list-only filters / one predicate across catalog, geography and selection; current key-only / expected-version selection | Shared authority; classified selection closed until G4; later atomic Local eligibility + stale-version precondition | Before classified activation / later D10 |
| D12 | **PROPOSED — NOT APPROVED** | Perpetual legacy exception / frozen approved cohort with reviewed transition / immediate hide; in-flight authoring, starter and legacy Hunt publication exceptions | Approved cutover cohort; no automatic reclassification; defer cutover until explicit client/starter/in-flight/Hunt policies are agreed | Before legacy behavior changes |
| D13 | **PROPOSED — NOT APPROVED** | Parallel authoring APIs / extend current routes with dedicated community-copy operation; error/disclosure contract | Extend existing routes and version envelopes; proposed names in section 8; fail closed without private-state disclosure | Before OpenAPI/API implementation |
| D14 | **PROPOSED — NOT APPROVED** | App-only / normalized constraints plus database immutability; exact table/lock design | Constraints + protected classified metadata/version/lineage, review-compatible locks and retirement/deletion coverage | Before SQL/model implementation |
| D15 | **PROPOSED — NOT APPROVED** | Automatic classify/backfill / nullable expand-first plus explicit cutover; destructive rollback / retained lineage | Nullable expansion, no old JSON/review/snapshot updates; closed activation; forward correction after copies | Before migration/deployment planning |
| D16 | **PROPOSED — NOT APPROVED** | Locality/provider, dedup/manual reconciliation, evidence validity/withdrawal/publish rules | Separate small contract reviews before G4 eligibility: stable internal Locality UUID; provider/manual ambiguity closed; evidence proportional; no provider certification. Provider, license, thresholds, validity/re-review and legacy Hunt operation policy remain undecided | Blocks Local submit/approval/selection readiness, not this documentation |

Approval record template (repeat per decision; no values filled by this proposal):

```text
Decision ID:
Status: PROPOSED — NOT APPROVED
Chosen option / amended contract:
Scope and compatibility conditions:
Product Owner approver:
Decision date:
Review / issue link:
Technical reviewer and dependent slices:
```

The full contract is not approved by choosing only its storage design. If a decision remains open, only independent approved slices may proceed; any dependent behavior stays closed. Reconcile Master Plan references and security/deployment prerequisites without treating this register as deployment authorization.

## 11. Smallest safe implementation slices — future, individually reviewed

| Slice | Contents / explicit boundary | Prerequisites and exit evidence |
| --- | --- | --- |
| C0 — this PR | Backend inventory, alternatives/recommendations, decision register and acceptance plan only | PO reviews decisions; no schema/runtime changes; no completion claim |
| C1 — classification persistence | Additive nullable metadata, exact version binding and classified immutability/ownership constraints; schema baseline; migration tests | D01/D02/D07/D14/D15 approved; historical fingerprints unchanged, rollback/constraint cases; no enabled classified API |
| C2 — owned authoring contracts | Extend current create/read/version OpenAPI/model for Universal and scratch Local; category validation; submission/review/Organizer gates remain closed for classified artifacts | D03/D06/D08/D09/D11/D13 and approved client/legacy transition; A01–A03/A08/A10–A11; no category UI |
| C3 — exact Universal approval/publication | Existing workflow extension for Universal validation and authoritative independent approval/publication; automatic reuse by all active authorized Creators under PO-approved D04; no separate consent/release mechanism or Local certification | D04 approved; D05/D09 and needed D10 lifecycle decisions still require approval; A05/A09/A11; exact source authority cannot be bypassed |
| C4 — community read and copy | Creator metadata discovery + atomic Local copy/lineage using eligible exact Universal; no provider lookup or Organizer exposure | C1–C3; D06/D07/D08/D13/D14; A04–A08/A10–A11 with real concurrent transactions |
| C5 — revision loop | Changes-requested authoring/resubmission, then only separately approved post-approval/re-review behavior | D10 full state/history contract; pin/review/version regressions; not bundled into C4 |
| C6 — location/evidence contracts then implementation | Separate provider/identity/manual-resolution and evidence/validity/publish contracts, followed by narrow Local persistence/validation and G4 review slices | D16 approved in parts; no guessed provider, thresholds or safety certification; A12; requires representative Local submissions |
| C7 — explicit legacy transition and eligible Local selection | Read-only inventory/reviewed cutover; all resolver/publish gates and approved adaptation/client/starter policies | D11/D12/D15 plus G4; A10–A13; preserve old Hunts; then reviewed D10 contracts and FE integration |

Separate Creator FE integrations follow available reviewed contracts. G4 category-specific Admin UI/workflow and D10 Organizer map-first UX remain their own workstreams. Deployed supply-chain verification must record revisions and actual cases before Participant runtime; passing unit tests or merging C1–C4 does not satisfy that gate.

Excluded here and from an initial foundation slice: Participant enrollment/gameplay, personal Hunt authoring, geographic provider search implementation, AI generation, GPS/route safety certification, full community discovery UI, unrelated auth/JWT work and automatic rollout. No merge or deployment occurs as part of this task.
