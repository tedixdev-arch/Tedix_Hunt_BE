# F7/C6b-4 — Locality binding contract

**Proposed contract for ChatGPT review — documentation only, 28 October 2026.**
No implementation, merge, deployment or activation is authorized by this document.

## 1. Reviewed baseline and boundary

Reviewed BE main `465775a47a1f699314377130f140aa341fd83d1b` and
[FE Master Implementation Control Plan v3, reconciled 28 October](https://github.com/tedixdev-arch/Tedix_Hunt_FE/blob/53a3e376025adb161e28430a4d6c8ebe35644218/docs/TedixHunt_Master_Implementation_Control_Plan_v3.md), especially §§5, 8–9.

Sources: [C6a proposal](F7_C6a_Hybrid_Locality_Contract.md),
[C6b-1 foundation](F7_C6b_1_Country_Locality_Foundation.md),
[C6b-3 proposals](F7_C6b_3_Manual_Locality_Proposals.md),
[Template model](../src/models/HuntTemplate.ts),
[Creator routes](../src/routes/creatorTemplates.ts),
[Geography model](../src/models/Geography.ts), and
[proposal model](../src/models/LocalityProposal.ts).
Migrations 022–025 and current classification, publication, geography, proposal,
Creator, Admin review and Hunt snapshot regression assertions inform this contract.

Current saves already append complete versions under an owner-scoped Template
identity lock; migration 022 freezes classified versions. Stored catalog reads and
independently approved manual Localities exist. There is no Template binding yet.
Approved Local saves remain forbidden; only approved Universal revisions and
classified changes-requested corrections are supported.

**Decision:** the next implementation is binding-only through existing save/read
paths. It does not enable approved Local revisions, impose new submission/approval
locality gates, or open classified Organizer selection. The reconciled plan and
this task supersede C6a §7/U2's temporary withdrawal recommendation: an approved
Local version retains eligibility during replacement review unless Admin explicitly
suspends it. That continuity mechanism and suspension behavior require separate
review; do not generalize Universal-only `published_version` in this slice.
“Retains eligibility” does not open today's closed Organizer gates.

## 2. Persistence and immutable snapshot

Add only nullable `locality_id UUID REFERENCES localities(id) ON DELETE RESTRICT`
and `locality_snapshot JSONB` to `hunt_template_versions`, using the next additive
forward migration and matching fresh `schema.sql`; register it in the existing
migration list. Do not edit old migrations or add an association table.

Both columns are SQL NULL together or populated together. A populated pair is
permitted only when version `category = 'local'`; explicitly reject NULL category
and Universal (avoid SQL CHECK three-valued-logic loopholes). PostgreSQL must also
reject JSON null/non-object snapshots, missing or incorrectly typed required
fields, and a snapshot ID different from the FK. Reuse the existing category/owner
binding trigger and classified UPDATE protection; no mutation of existing versions,
including drafts. Preserve existing protected-deletion and unused-draft deletion rules.

The server snapshot has exactly the public catalog facts:
`id`, `countryCode`, `countryDisplayName`, `name`,
`administrativeContext`, `latitude`, `longitude`.
Use bounded nonblank strings and finite, bounded numeric coordinates as in the
catalog. Exclude `active` (current operational state), provider identity,
raw provenance, proposal evidence, Admin identity and decision reason. Manual
provenance currently contains private decision metadata and must not be copied.
The point identifies the settlement, not a route boundary, checkpoint or safety
certification. No inference from Template geography or Hunt country/region/city strings.

Only the server constructs fresh snapshots from stored catalog rows. Catalog
corrections, deactivation and country-name changes never rewrite saved JSON.
Locality UUIDs must never be reassigned to different places. The FK protects
referenced identities; the snapshot preserves selected context. Future
storage-permitted provider attribution needs separate review before activation;
this slice introduces no Mapbox persistence or entitlement assumption.

## 3. Selection, saves and errors

Creator chooses Country, searches active stored Localities using existing
`GET /api/geography/countries` and
`GET /api/geography/localities?countryCode=RO&q=Cluj`, inspects name/context/point,
then explicitly saves the chosen UUID. No first-result auto-selection.
Existing `GET /api/geography/localities/{id}` resolves current state, including
inactive records. No new lookup or binding endpoint.

Add optional top-level `localityId` beside `content` on
`POST /api/creator/templates` and `POST /api/creator/templates/{key}/versions`.
Create retains existing `key`/`category` fields; version save retains complete
content and server-calculated next version. Requests never accept `localitySnapshot`
or client canonical facts as binding metadata.

| Local request | Result in the newly inserted version |
| --- | --- |
| Scratch create: omitted or null | Both columns NULL; incomplete draft allowed. |
| Subsequent save: omitted | Copy immediate predecessor's ID and JSON exactly, including a NULL pair. No catalog refresh. |
| Subsequent save: explicit null | Clear selection in this new version only. |
| Explicit UUID on either save | Require an existing active catalog Locality; capture fresh server snapshot. Same UUID explicitly supplied also refreshes facts in a new version. |

Omission may inherit an inactive Locality into a draft so ordinary authoring remains
possible; it does not authorize future submission/approval/selection. Explicit
selection of that same inactive UUID fails. Country comes from the chosen record;
no redundant expected-country input or country inferred from route content.

Universal and unclassified requests must omit `localityId`; even explicit null
returns 400 `invalid_input`. Their stored pair remains NULL. C4 Universal-to-Local
copy and legacy starter requests stay unchanged: the new copy starts unbound,
then uses the ordinary version-save endpoint. Source geography never supplies a binding.

Use existing `{"error":"code"}` envelope:
malformed UUID/type/forbidden metadata → 400 `invalid_input`;
well-formed absent catalog UUID → 404 `locality_not_found`;
inactive explicit UUID → 409 `locality_unavailable`.
A proposal UUID is not a catalog UUID: pending/rejected proposals have no usable
binding and return the same absent-catalog error. C6b-3 status is **approved**;
Creator must explicitly save its returned `localityId`, not its proposal ID.
Proposal approval never changes a Template.

Preserve persisted active non-guest Creator authorization and owner-scoped lookup
before catalog resolution on version save: missing/other-owner/platform Template
→ existing indistinguishable 404; noneditable lifecycle → existing 409.
Admin/Organizer capability alone grants no authoring access. Existing content,
stale-version and key-conflict errors remain.

## 4. Reads, lifecycle and history

Return additive sibling `localityId`/`localitySnapshot` (null pair when unbound)
with existing Creator save, list, detail and submit version representations.
Project the saved pair from the same row as returned content/version.
Existing Creator reads remain latest-version reads; no new historical route or
version query parameter. Existing internal exact-version reads and Admin
submitted-version representations must project the pair from their pinned row,
never from latest content or a live catalog join. Review responses preserve that
same pair. Current catalog state is available separately through existing lookup.

Any binding change, clear or explicit refresh requires a new immutable version
with complete content, even when gameplay is otherwise identical. No PATCH,
retrofit, approval inheritance or proposal-triggered association.
Submitted and approved Local versions remain noneditable under current rules;
changes-requested Local correction continues through the existing new-version path.

Historical unbound Local versions, pending submissions and approved versions stay
readable and retain existing lifecycle behavior in this foundation. Do not enforce
`locality_required`, active-at-submit/approve checks or material-catalog-change
review rules here. C6b-5 must separately review those gates and compatibility
handling; it cannot silently backfill an old approval.

No historical backfill, Signal: Cluj-Napoca modification/classification, content
schema rewrite, Hunt snapshot migration, source propagation, or Universal
publication/provenance changes. Saved Hunts retain their exact existing snapshots.
Future classified Hunt selection must copy the exact approved version's locality
snapshot together with its content; never reconstruct history from current catalog.
That resolver and any inactive-place effects on future Hunt publish/start are
deferred G4/C7/D10 work.

## 5. Transactions, concurrency and risks

Reuse the existing transaction/client: lock owner-scoped Template identity,
validate lifecycle, read the latest predecessor and calculate/validate next
content version. For explicit selection, acquire shared locks on the selected
Country then Locality, re-read their joined facts and check active status before
inserting. Resolve country initially without trusting it across the lock:
recheck country membership under the Locality lock and abort with 409
`locality_unavailable` if it changed. Hold locks through commit. Country locks
freeze its display name; Locality locks block ordinary correction/deactivation
until the snapshot commits. No network calls inside transactions.

Catalog writers must use Country → Locality order and never acquire Template
locks; saves use Template → Country → Locality. Omitted inheritance needs no
catalog refresh/active check; FK and existing version protections still apply.
Create identity + version + pair, or append version + lifecycle updates, commit
together. Any validation, constraint or commit failure rolls everything back.

Two saves serialize on the identity. Existing complete-content version validation
rejects a stale candidate rather than overwriting another save; no new expected-version
field or idempotency store. A lost-response retry may receive the existing stale-content
error; clients reload. Race tests must prove outcomes using separate connections.

Risks: inherited facts can be stale or inactive by design; display current catalog
separately when needed. Binding does not establish route fit, evidence validity or
safety. Initial countries remain RO-only and same-name identities remain distinct.
Direct privileged SQL can bypass server snapshot construction; normal constraints
must still reject invalid pairs/categories and preserve immutable history.
The FE plan's proposal-only account-deletion dependency concern is separate work,
not an authorization to expand this implementation.

## 6. Implementation acceptance checklist

Required evidence for a later implementation PR, using disposable PostgreSQL and
real model/HTTP paths (`TEST_DATABASE_URL` enabled, no skipped integration suites):

- [ ] Additive upgrade from pre-binding schema, migration rerun and fresh-schema
  parity; old rows get NULL pairs without rewriting content/reviews/Hunts.
- [ ] SQL rejects half pairs, JSON null/invalid shape/types/mismatched ID, invalid FK,
  Universal/legacy binding and classified UPDATE attempts; referenced Locality
  deletion fails. Existing permitted unused-draft deletion still works.
- [ ] Local scratch select/omit/null; exact inheritance after catalog correction;
  explicit same-ID refresh, different-ID change and clear create new versions only.
  Inactive inheritance works; explicit inactive fails; old snapshot stays unchanged.
- [ ] Malformed/unknown/inactive/proposal IDs produce specified errors with no
  writes. Approve a manual proposal through C6b-3, then explicitly bind its returned
  catalog UUID; approval alone never associates a Template.
- [ ] Creator list/detail/save/submit and pinned Admin/internal reads return pairs
  from the same exact content row, including historical NULLs and stale catalog facts.
  No metadata/evidence leak or client snapshot injection.
- [ ] Persisted capability, guest/blocked/retired/revoked-role denial, other-owner
  nondisclosure, Universal/legacy denial and submitted/approved Local save denial.
- [ ] Inject failures after identity/version insertion and lifecycle update, including
  commit failure; verify full rollback and reusable pooled connections.
- [ ] Concurrent complete-content saves yield no duplicate version or mixed pair;
  save versus submit respects existing locks; explicit selection versus catalog
  correction/deactivation/country rename yields a coherent before-or-after snapshot
  or the specified rejection, with no partial write or deadlock.
- [ ] Preserve Signal, legacy strings, version/review/Hunt fingerprints, exact Universal
  publication and C4 provenance. Existing unbound submission/review behavior remains;
  classified Organizer catalog/geography/direct Hunt selection stays closed.
- [ ] Report focused and full PostgreSQL regressions plus typecheck/build and diff
  checks. Do not claim deployed/E2E/provider-entitlement verification.

This review inspects source and test assertions; it does not rerun application or
PostgreSQL tests. Delivery is one documentation-only Draft PR; stop for ChatGPT review.
