# F7 Backend Template contract proposal

**Documentation only. Product rules below: PO APPROVED — 2026-10-27. Unresolved technical decisions: PROPOSED — NOT APPROVED.**

This revision records the Product Owner's instruction to simplify existing Draft PR #75 around the agreed product model. Source of approval: the Product Owner's explicit eleven-rule instruction in this conversation on **2026-10-27**, reproduced in section 3. It extends the earlier D04 approval from the same date. Approval of those product rules does not approve storage, API names, migrations, publication/withdrawal state transitions or revision mechanics.

No code, migration, model, authorization, UI or deployed behavior changes. Do not implement or merge this proposal without the required technical review and authorization. The approved sequence remains **F7 → G4 → D10 before Participant runtime**, with no pilot exception; none is complete on the strength of this document.

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

## 3. Agreed product model — PO APPROVED — 2026-10-27

Source: Product Owner instruction to update existing Draft PR #75, 27 October 2026. These are approved product rules, not alternative recommendations:

| Rule | Approved behavior |
| --- | --- |
| P01 | A Creator can create a Universal Template from scratch. |
| P02 | An independently Admin-approved and published Universal becomes available to all authorized Creators. |
| P03 | Any authorized Creator can use a published Universal as the foundation for an independent Local Template, freely adapting their Local copy. |
| P04 | A Creator cannot modify another Creator's Universal or publish a derivative Universal from it. |
| P05 | Only the original Creator can revise and republish their Universal. |
| P06 | Local Templates can also be created from scratch. |
| P07 | Local Templates require independent Admin approval before Organizer selection. |
| P08 | No separate community-reuse consent, Admin reuse-release workflow, notifications, subscriptions or Creator-to-Creator communication. |
| P09 | The Creator-facing library presents finished published Templates, not historical versions. |
| P10 | Revisions and publication must not change existing Local copies or Hunt snapshots. |
| P11 | Published Templates with dependencies must not be destructively deleted; withdrawing them from future selection is distinct from deleting historical records. |

Universal is reusable content/mechanics without an approved physical route; Local supplies locality, geography and adaptations. Both remain Templates assembled with the existing Creator Framework, not new engines. Universal approval does not approve Local geography.

The product flow is:

1. Creator authors their own Universal from scratch → independent Admin review → published Universal appears as a finished product in the Creator library.
2. An authorized Creator selects that product → Backend creates an independent, Creator-owned Local → Creator freely adapts it → independent Local review → Organizer selection only after the applicable Local eligibility gates.
3. Alternatively, Creator authors Local from scratch → the same independent Local review and eligibility gates.
4. The original Creator may revise/republish their Universal. Previously created Local copies and saved Hunt snapshots remain unchanged. Internal version/review history supports this guarantee without becoming a historical-version chooser for other Creators.

No Universal → Universal, Local → Universal or Local → Local reuse workflow is proposed. Publishing another Creator's Universal as a derivative Universal is forbidden. Independent Local ownership does not confer source editing rights. Free adaptation of Local content remains subject to supported framework and Local validation/review; it is not constrained to a small approved diff against the Universal.

## 4. Creator-visible Templates and internal records

**Approved distinction (P09):** the library is a product library. It presents finished published Templates, not version histories. Universal entries can be used as Local foundations. This does not authorize copying Local entries or make Universal entries Organizer-selectable. Category projections and exact library layout remain technical/UI decisions; no new Local browsing or communication workflow is introduced.

**PROPOSED — NOT APPROVED technical mapping:** one product identity is represented by its currently authoritative published artifact; immutable authoring versions and exact approval records remain internal. An owner authoring workspace may need draft/revision status, and Admin review must identify the exact submission. Those internal needs do not turn the shared library into a version catalog.

A library item should identify the Template product and provide a concurrency reference to its current published artifact. A technical version number or opaque publication reference may be carried by API payloads without offering historical versions as user-selectable products. The representation is unresolved (D05-T/D13).

On copy, the Backend resolves that product's authoritative approved/published immutable artifact. It never trusts client-supplied content, owner, category, approval or source attribution. If publication changes between display and copy, the proposed API rejects a stale reference and requests a refreshed product selection; it does not silently copy a different artifact or offer a historical-version fallback.

Historical source versions remain retained for provenance, approval evidence and existing copies. They are not separate reusable products in the Creator library. Whether a current internal version is old or new is irrelevant to existing copies: their content is already independent.

## 5. Authorization, lifecycle and copying

### 5.1 Ownership and approved publication

P01–P07 are **PO APPROVED — 2026-10-27**. Technical enforcement is **PROPOSED — NOT APPROVED**:

- Use current persisted active non-guest Creator capability, including multi-role accounts. Admin-only or Organizer-only is not Creator authority.
- Owner-only source writes/revision/publication: the original Creator retains their Universal. Another Creator can read the published product as authorized and create a Local, but cannot edit the source, revise/republish it or create a derived Universal.
- Local ownership is the copying Creator, or the author for scratch Local. Source author attribution is provenance, not ownership of the Local.
- Universal publication must refer to an independently Admin-approved exact artifact. An owner's right to revise/republish does not permit bypassing independent approval for changed content. An Admin/Creator combined identity cannot approve its own submission.
- Publication makes the Universal automatically reusable by all authorized Creators. There is no second reuse permission, consent flag, release record, per-Creator allowlist, subscription or notification requirement.
- Local approval is independent of source approval. Universal remains outside Organizer selection; newly classified Local remains outside selection until the G4 eligibility gates exist.

The agreed product lifecycle is authoring → independent review → publication/availability, with owner revision and republication. It is not a proposed database enum or a new manual approval/publication choreography. Whether approval atomically establishes publication, and how a draft revision coexists with the existing published artifact, remain technical decisions D05-T/D09/D10. No extra release workflow is authorized.

### 5.2 Universal → Local only

**Proposed atomic copy contract:**

1. Check actor capability and resolve the selected published Universal product.
2. Resolve its exact authoritative independently approved/published immutable artifact. A draft, submitted, changes-requested, unapproved, unpublished, Local or unclassified artifact is not a community-copy source.
3. Allocate an independent destination identity and first Local version, owned by the copying Creator.
4. Snapshot source content and write exact source provenance in the same transaction. Only documented destination identity/version mapping occurs; do not invent GPS, locality, route evidence or inherited approval.
5. Commit all destination records together or roll back all of them. Later Local versions preserve lineage while the Creator freely adapts their content.

Scratch Local follows the normal owned-draft path with no Universal-source provenance. Scratch Universal does not accept another Template as a source. The copy operation has a fixed Local destination category; callers cannot select Universal. Subsequent Local version saves cannot change it to Universal or replace source lineage.

The Backend must enforce these restrictions on all supported authoring/publication paths, including internal helpers. A category or provenance field hidden in extensible JSON cannot override authoritative metadata. Ownership and declared lineage can be enforced; arbitrary semantic copying from manually supplied narrative cannot be inferred reliably from JSON. No plagiarism detection or cross-Creator moderation workflow is invented here.

**Unresolved implementation details:** lock order with account/role/review/publication mutation, key allocation, retries/idempotency, exact validation matrix and stable error responses. Source account retirement must not silently mutate an existing published artifact or its dependencies. Any future effect on publication/availability requires separately reviewed mechanics; no extra source-account copy gate is adopted here.

### 5.3 Immutable provenance and history

Required integrity is established; representation remains **PROPOSED — NOT APPROVED (D07/D14)**. Retain:

- Exact source Template identity and immutable version identity/number.
- Original Creator attribution, separate from destination ownership.
- Destination identity/initial version and the authoritative exact approval/publication reference used at copy time.
- Server copy time and any explicitly reviewed copy mapping revision.

Recommend normalized source references and immutable lineage, rather than client-editable content fields. Alternatives are version metadata versus a normalized lineage record with restrictive exact-version references; SQL constraints/triggers and deletion interactions require review. Do not store an independent reuse grant.

Later Local edits retain the same lineage even after extensive adaptation. No source update, new publication, withdrawal or retirement silently rewrites an existing Local or Hunt snapshot. Update-from-source, derivative Universal publication and subscriptions are outside the product model.

### 5.4 Dependency protection versus withdrawal

P11 is **PO APPROVED — 2026-10-27**. A published Template with dependent Local copies, protected review/provenance records or Hunt history must not be destructively deleted. Removing future availability is distinct from deleting identity, historical versions or references. Existing snapshot fields are not Template FKs, so FK protection alone is insufficient.

Withdrawal mechanics remain **PROPOSED — NOT APPROVED**: actor authority, state representation, effective time, concurrent selection behavior, future selection/reselection and Hunt publish-readiness consequences. No withdrawal endpoint, new permission or automatic account-retirement transition is approved by this document. Preserve previous copies and snapshots; do not use withdrawal to erase or retroactively rewrite them. Do not infer deletion rules for dependency-free published records beyond existing Backend protection.

## 6. Compatibility and current Backend contradictions

The product model is clear; these implementation gaps must be resolved rather than hidden:

| Current Backend | Difference from the approved target / required response |
| --- | --- |
| Creator version creation and submission accept only draft identities; approved identities are frozen. Changes-requested revision/resubmission is absent. | P05 requires original-owner Universal revision/republishing. Current API cannot deliver it. D10 must design draft-versus-published authority and exact reapproval without mutating previous artifacts. |
| Identity has one status and one submitted-version pin; there is no Template publication or withdrawal state. | D05-T/D09 must map a published product to the exact approved artifact, including behavior during revision. Do not rename an existing enum or invent a second reuse-release step. |
| One review row per Template/version; current history is a minimal record, not a repeated-review event log. | Revisions need new immutable artifacts and preserved review evidence. Whether more approval-history structure is required remains D10/D14; do not overwrite existing decisions. |
| Generic approved catalog includes every approved identity; Creator pin and platform latest-version resolution differ. | Universal must not become Organizer-selectable. Shared listing, geography and direct-key Hunt selection must enforce the approved audience/category boundary without breaking legacy platform behavior. |
| No category or exact copy-lineage schema; extensible content and helper writes are less strict than new category authority would need. | D01/D07/D14 must enforce Universal → Local only and owner-only Universal revision at persistence/API boundaries. Existing starterSource is not authoritative Universal provenance. |
| Authoring reads expose latest versions; professional catalog returns metadata/geographic projections, not a Creator product library. | Library must expose finished published products, while owner authoring and Admin exact review remain distinct projections. Do not expose historical versions as reusable library choices. |
| Legacy approval, geographic compatibility and Signal fixtures predate categories; old review rows were not fabricated. | Do not classify Signal by name/coordinates, backfill approval evidence or make new classification requirements apply retroactively. |
| Hunt selection snapshots complete content, but references are not Template FKs. | Preserve independent snapshots and protected deletion checks; new lineage references must complement, not replace, existing Hunt-reference protection. |

**Legacy strategy is unresolved (D12/D15).** Preserve unclassified reads, historical Signal and Overload definitions/starters, approved versions/reviews, existing catalog consumers and saved Hunts. Before any cutover, inventory actual records/consumers and compare before/after fingerprints on disposable fixtures. No live data census was performed here.

Technical options include nullable additive metadata with explicit legacy compatibility versus a separately reviewed adaptation/transition. Recommend additive metadata and no historical JSONB rewriting. Do not automatically classify old Templates, impose a new frozen cohort, disable starters, hide the existing catalog or strand in-flight authoring/Hunts without an explicit reviewed transition. A classified adaptation cannot pretend that an unclassified source was a published Universal.

New classified selection stays closed until its required review/Local eligibility gates are implemented. Category-specific validation and geography/evidence must preserve current configuration.normalCheckpointCount, checkpointPositions and separate finishPoint. Universal needs reusable content without fixed geography; Local drafts can be progressive while their submission/approval rules need a separate reviewed matrix. No route safety certification or locality/provider mechanics are inferred.

## 7. Proposed API and persistence boundaries

**All API names, payload additions, errors and schema designs in this section: PROPOSED — NOT APPROVED.** Extend existing authoring/review conventions; do not create a parallel engine.

| Surface | Proposed contract / approved product boundary |
| --- | --- |
| Existing Creator create | Explicit Universal or Local scratch creation with ordinary content; authenticated owner; no source/provenance/status override. Legacy client compatibility needs D12. |
| Existing owner list/read/version | Owner workspace for drafts and revision context, not the shared product library. Source Universal writes restricted to its original Creator; Local writes restricted to its owner. Category/lineage immutable through version saves. |
| Creator published-product library | Entries represent finished published Templates, without historical-version choices. Universal product selection enables Local creation only. Category projection, preview detail and pagination are unresolved. No new Local reuse workflow. |
| Universal-to-Local copy | Dedicated operation with source product key and expected current publication reference (opaque token or internal version binding TBD), optional destination key. Backend resolves exact source artifact; destination always Local and owned by actor. Reject stale selection rather than substitute another artifact. |
| Existing submit/Admin review | Review exact immutable submission with category context; independent approval. Universal publication automatically implies reuse; Local approval does not inherit from Universal. No consent/reuse-release endpoints. |
| Original-owner revision/republish | Reuse existing authoring conventions where safe, but current frozen approved lifecycle needs D10 design. No endpoint/state-transition mechanics are approved in this document. Nonowners and derivative Universal publication are denied. |
| Professional catalog/geography/Hunt selection | Universal excluded; Local independently approved and otherwise eligible before Organizer selection. Apply consistent authority to list, inspection and direct-key selection. Preserve approved legacy behavior until reviewed transition. |
| Deletion/availability | Preserve protected records/dependencies. Withdrawal is not DELETE. Authority, payload, state transitions and effects remain unresolved; no new operation is specified here. |

Responses may expose internal exact version/provenance identifiers where authorized without presenting history as selectable products. Keep existing professional geographic allowlists; no answers, private drafts or review evidence leak through library/catalog fields. Public attribution and full preview detail remain D08 decisions. Authorization precedes private lookup; retain indistinguishable other-owner/absent errors. Invalid metadata fails validation; lifecycle/stale-reference conflicts must not leave partial copies.

Recommended persistence direction: nullable category metadata for old identities; exact version/approval binding for classified artifacts; immutable source lineage; owner/category consistency; uniqueness; transactional source resolution/copy; restrictive dependency preservation. Storage on identity versus version and normalized constraints versus triggers remain D01/D07/D14. No consent/release tables, notification records or subscriptions.

Recommended migration direction: new additive numbered migrations, unchanged 001–021 history and schema baseline consistency; no historical content/approval/snapshot updates. Activation order and rollback require review. Rollback must preserve created lineage/history and prevent generic Organizer exposure; it cannot simply drop dependent records. This paragraph is a proposal, not an approved migration or deployment plan.

## 8. Acceptance criteria — future implementation tests, not executed here

Use real disposable PostgreSQL for persistence, transactions, migrations and races; run existing regressions, typecheck/build for implementation slices and report actual execution/skips. No runtime tests are claimed by this documentation revision.

| ID | Testable requirement |
| --- | --- |
| A01 | Active authorized Creator can author Universal and Local from scratch; guest, blocked/retired, Participant-only, Organizer-only and Admin-only cannot exercise Creator authoring. Persisted multi-role authority and ownership prevail. |
| A02 | Another Creator cannot modify, revise or republish the source Universal. Only its original Creator can revise/republish; changed content needs its own exact independent approval. Prior immutable artifacts/reviews remain unchanged. |
| A03 | Independently approved/published Universal product is available to every authorized Creator without consent, separate release or inter-Creator interaction. Shared library exposes finished products, not historical reusable versions; no subscription/notification dependency. |
| A04 | Copy is Universal → Local only. Reject derivative Universal destination, Local source, arbitrary historical-version selection, unpublished/draft/submitted/changes-requested/unapproved/unclassified source and forged owner/approval/provenance. Client key/version cannot bypass server authority. |
| A05 | Copy allocates independent Local identity/history owned by actor, with exact source version and original Creator provenance. Creator can freely adapt Local content within normal framework/validation; neither editing rights nor approval transfers back to source or into destination. |
| A06 | Local scratch has no Universal provenance and uses the same Local approval gates. Universal source approval never makes a Local Organizer-selectable. |
| A07 | Publication/revision races copy: copy either uses the exact authoritative displayed artifact or returns a stale-selection conflict. Same-key concurrent requests cannot create duplicate/orphan identities; injected failures roll back complete copies. Retry semantics await D06. |
| A08 | Universal revisions/new publication and Local adaptation never change previous Local versions/lineage or Hunt snapshots. No automatic update-from-source or retroactive restriction. Test permitted revision mechanics after D10 design rather than inventing an approved-source editing shortcut. |
| A09 | Reject destructive deletion of published Templates with Local/provenance/review/Hunt dependencies, including existing snapshot references without FKs. Any later withdrawal affects only the explicitly approved future-selection behavior, preserving historical records and copies. Withdrawal race/authority tests await approved mechanics. |
| A10 | Database and API enforce owner/category/source consistency and immutable version/provenance fields. Exact submitted approval, independent self-approval rejection, current self-request-changes behavior and account anonymization/protected history remain intact. |
| A11 | Universal/new ineligible Local cannot leak into Organizer catalog, geography or direct-key Hunt selection. Local only selectable after independent approval and required G4 eligibility; unauthorized requests do not disclose hidden content or source existence. |
| A12 | Migration fixtures preserve Signal IDs/checksum/content, historical approved versions/reviews/pins, starter behavior and complete Hunt snapshots. No automatic classification, retrospective evidence or geography normalization; legacy reads/selections follow explicitly reviewed compatibility. |
| A13 | New category validation differentiates reusable Universal from progressive Local drafts and complete Local review. Invalid locality/evidence/blockers fail under later approved G4 contracts; no provider/AI/GPS safety certification. |

## 9. Decision register

Product approval and technical approval are separate. P01–P11 above are **PO APPROVED — 2026-10-27**, citing the Product Owner instruction in this conversation. D04/D05 below summarize the approved product rules. Every unresolved technical row remains **PROPOSED — NOT APPROVED**; approved product behavior is a constraint on those choices, not an alternative they may overturn.

| ID | Status | Decision / remaining scope |
| --- | --- | --- |
| D01 | **PROPOSED — NOT APPROVED** | Category storage: identity-only versus version-only versus immutable identity plus exact version binding (recommended). Preserve historical null/unclassified; no mutable relabeling of approved content. |
| D02 | **PROPOSED — NOT APPROVED** | Category-specific draft/submit validation matrix, supported mechanic fields and contract revision binding. Universal without fixed geography; Local requirements must not use the legacy bypass. |
| D03 | **PROPOSED — NOT APPROVED** | Technical enforcement of the approved ownership rules: capability/owner rechecks, locks, metadata protections and nonowner source-write denial. Independent Local ownership/original-owner Universal authority are approved and no longer alternative ownership policies. |
| D04 | **PO APPROVED — 2026-10-27** | Published independently Admin-approved Universal is automatically reusable by all authorized Creators, strictly as an independent Local foundation. No derivative Universal publishing; no separate consent/reuse-release/communication/notification/subscription workflow. Source: P02–P04/P08 and the earlier D04 PO decision in this conversation. |
| D05 | **PO APPROVED — 2026-10-27** | Library presents finished published Templates, not historical-version choices. Only original Creator revises/republishes Universal; publication/revisions preserve existing Local copies/Hunt snapshots; dependent published records are not destructively deleted. Withdrawal from future selection differs from history deletion. Source: P05/P09–P11. Technical mechanics are explicitly reserved to D05-T/D10/D11/D14. |
| D05-T | **PROPOSED — NOT APPROVED** | Internal published-artifact reference and exact approval mapping, stale-selection token and publication/withdrawal state representation. Whether approval establishes publication atomically and how draft revision coexists with publication remain open. No historical library version picker or extra reuse gate. |
| D06 | **PROPOSED — NOT APPROVED** | Key allocation/retry behavior and copy mapping: existing unique optional key with one-winner conflict versus actor-scoped idempotency; recommend existing key convention if sufficient. Destination always Local; no workflow alternatives. |
| D07 | **PROPOSED — NOT APPROVED** | Provenance storage: immutable version metadata versus normalized exact source/approval/publication references (recommended); lineage inheritance and dependency retention. No reuse-grant records. |
| D08 | **PROPOSED — NOT APPROVED** | Safe attribution/preview projection: durable internal Creator UUID plus current audience-safe label recommended over frozen personal profile values; public identifiers/full preview require review. |
| D09 | **PROPOSED — NOT APPROVED** | Integration of independent category validation/review with publication, same approval conventions; classified activation remains closed until supported. No separate community release stage. |
| D10 | **PROPOSED — NOT APPROVED** | Original-owner revision/republish mechanics: authoring state versus published pointer, new immutable submission/approval, changes-requested loop and review-history constraints. Revision is approved product behavior; permanently frozen Universal is not the target model. |
| D11 | **PROPOSED — NOT APPROVED** | Shared selection authority/atomicity across library, geography and Hunt save; withdrawal authority/timing, future selection/reselection and publish-readiness effects. No destructive deletion or snapshot rewriting. |
| D12 | **PROPOSED — NOT APPROVED** | Explicit legacy/client/starter/in-flight/Hunt compatibility transition; inventory and reviewed adaptations. No automatic classification, silently frozen cohort or catalog removal. |
| D13 | **PROPOSED — NOT APPROVED** | Concrete route names/envelopes/projections, stale-reference/errors/pagination. Extend existing conventions with fixed Universal → Local operation, no alternate copy directions. |
| D14 | **PROPOSED — NOT APPROVED** | SQL constraints/triggers/FKs/locks and dependency checks, including existing non-FK Hunt snapshots, internal-helper enforcement and account retirement compatibility. |
| D15 | **PROPOSED — NOT APPROVED** | Additive migration, activation/cutover and rollback design. Preserve history; no consent/release schema or destructive provenance rollback. |
| D16 | **PROPOSED — NOT APPROVED** | Separate Locality/provider/manual-resolution and Local evidence/validity/G4 eligibility contracts. Provider, licensing, deduplication and operating conditions are not invented here. |

Technical approval record for each unresolved row must identify chosen representation, conditions/compatibility, PO/technical reviewer, date and review link. Blank records do not imply approval. Product approvals in this revision do not authorize implementation or merge; no new state machine, migration, withdrawal authority or manual publishing action is inferred.

## 10. Smallest future implementation slices

Each slice requires its unresolved technical decisions to be reviewed before implementation. These are proposed boundaries, not authorization to start.

| Slice | Scope and dependency / exit evidence |
| --- | --- |
| C0 — this Draft PR | Documentation and approved product/technical decision separation. No runtime change; F7/G4/D10 not complete. |
| C1 — classification/provenance foundation | D01/D02/D07/D14/D15 approved: additive metadata and exact binding/dependency protection, disposable migration/history-preservation tests. No enabled new selection. |
| C2 — owned scratch authoring | D03/D06/D09/D12/D13 approved: Universal and Local scratch paths through existing conventions, category/owner integrity and initial closed category gates. A01/A06/A10/A12. |
| C3 — published product authority | D05-T/D08/D09/D11/D13 approved: exact independent Universal approval/publication and product-library projection. Automatic reuse under D04; no release subsystem or historical version chooser. A02–A04/A11. |
| C4 — Universal → Local copy | C1–C3 plus approved copy/locking contracts: independent Local snapshot/lineage, free owned adaptation, source-write/derivative-Universal denial, concurrency/rollback and deletion protection. A04–A10. |
| C5 — original-owner revisions | D05-T/D10/D14 approved: immutable owner revision/reapproval/republish and changes-requested handling, coherent published-product reference during authoring. A02/A07/A08; no subscriptions or source-update propagation. Separate slice does not defer this required product capability indefinitely. |
| C6 — Local governance | D16 and related category review contracts approved: locality/evidence persistence and independent G4 Local review/eligibility in narrow slices. A06/A11/A13; no claimed safety certification. |
| C7 — reviewed compatibility/selection rollout | D11/D12/D15 approved and G4 supported: explicit legacy transition and shared eligible Local selection/Hunt snapshot protection, then scoped D10 Organizer integration. A09/A11/A12 and deployed evidence. |

Creator/Admin/Organizer UI work follows separately reviewed available contracts. Full F7 → G4 → D10 supply-chain verification precedes Participant runtime. No AI generation, provider search implementation, Participant gameplay, personal Hunt authoring or unrelated auth changes are included.

## 11. Documentation validation and limits

Check product-rule coverage, approved-versus-proposed statuses, removal of obsolete workflows, fixed copy direction, all dependent API/test/slice references, Markdown tables/fences, repository links and changed-file scope. No application tests, PostgreSQL migrations, build or deployed verification are performed for this documentation-only revision. Existing D07 deployment configuration gates remain separate.

The current Backend inventory is source evidence, not deployed behavior or a live-data census. Historical records, existing Hunt snapshots and legacy APIs are unchanged by this PR. Do not implement or merge as part of this task.
