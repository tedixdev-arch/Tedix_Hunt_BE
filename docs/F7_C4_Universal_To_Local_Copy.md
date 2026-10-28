# F7/C4 — Published Universal to independent Local

Based on latest main `95da8c3` (merged C3 PR #78), verified with a fresh origin fetch. Inspected the F7 proposal, C1–C3 records, persistence constraints, Creator authoring, review and authorization, and FE architecture plan at `efe9c282a45bdfcd7b9bd36451270d068d6bdb62`, particularly the separate Universal/Local lifecycle and F7 → G4 → D10 boundaries. The current Product Owner request authorizes C4 over older proposal reservations. No schema deficiency was found; no migration is added.

## API

`POST /api/creator/templates/from-universal/{sourceKey}` requires authenticated persisted active non-guest Creator capability.

```json
{
  "key": "my-local-hunt",
  "publishedReference": {
    "templateId": "11111111-1111-4111-8111-111111111111",
    "version": 2
  }
}
```

The reference comes from the C3 library. Source key identifies the current product; both reference fields must exactly match its current published artifact. Destination key uses existing normalization and uniqueness rules. No ownership, category, status, approval, content or provenance input is accepted; nested reference fields are allowlisted too.

201 returns `{ key, version: 1, status: "draft", origin: "creator", category: "local", content }` using the existing authoring envelope. 400 `invalid_input` rejects malformed/extra fields. 401 requires authentication, 403 `forbidden` requires Creator capability, 404 `not_found` covers missing and nonpublished/non-Universal sources, 409 `stale_published_reference` requires a fresh selection, and 409 `template_key_conflict` requires a different destination key. No historical fallback or idempotency mechanism is introduced.

## Atomicity and publication authority

One PostgreSQL transaction rechecks and share-locks the persisted active user and Creator role, then locks the source identity `FOR UPDATE`. A separate statement after acquiring that lock re-resolves the C3 publication predicate, so a preceding publication writer cannot leave copy reading its pre-wait pin. Publication writers must continue locking this same identity. The exact submitted-version join and independent approved decision are required; latest/MAX(version) is never used. Exact version and review rows are share-locked through commit. Nonpublished sources fail closed.

After comparing both reference fields, the transaction inserts a new Creator-owned Local identity and immutable version 1. Unique destination collisions and any version-insert failure roll back both inserts. The copying Creator can also be the original author. Source identity, content and review are not written.

C1 provenance is inserted once: `source_template_id` = exact source UUID, `source_version` = exact published version, `source_creator_user_id` = original Universal owner, `source_review_decision` = `approved`. Existing composite FKs and insert-only triggers preserve evidence and immutable lineage across Local versions. Local versions retain their own owner/category. Provenance is persisted metadata, not injected into content or an editable request field.

## Snapshot and geographic rules

The entire approved JSON snapshot is copied with only top-level `key` and `version` replaced by destination key and 1. Gameplay, mechanics, narrative, challenges, scoring and extension content are preserved. JSON is independently persisted, with no runtime composition, synchronization or source write rights.

Optional source geography is preserved as ordinary unapproved Local draft content. The response always says draft; approval is never inherited, and no coordinates, route certification or evidence are fabricated. Existing owner version-authoring allows complete replacement snapshots. Existing Local submission validation still requires the full geographic/gameplay contract; source approval cannot bypass independent Local Admin review. Classified Organizer list/geography/direct Hunt selection gates remain closed even after Local approval.

## Verification

Disposable PostgreSQL 17 container `tedix-c4-test`, port 5544; each integration suite creates and drops its own database from baseline and migrations. No live database was accessed.

- Full Backend suite: **53 files / 1,031 tests passed, zero skips**.
- Typecheck, build and diff whitespace checks passed.
- C4 HTTP/PostgreSQL tests cover cross-Creator and same-Creator copies, exact snapshot/remapping, destination identity/owner/provenance, unchanged source, independent subsequent versions, stale UUID/version, unpublished and evidence-free sources, Local/legacy rejection, metadata injection, duplicate-key races, injected version-insert rollback, optional draft geography, incomplete Local submission, independent approval, closed Organizer resolver, and unauthorized/guest/blocked/retired users.
- Existing C1–C3, Signal, review history and Hunt snapshot regression suites pass.

The initial run without execution network permission failed socket binds and skipped PostgreSQL tests; the permission-enabled disposable PostgreSQL full run passed. The later source-version test is a SQL fixture, not a C5 API or a claim that approved Universal revision is implemented.

## Remaining scope

C5 must define published-pointer/revision coexistence and independent reapproval/republication, preserving this identity-lock protocol and stale-selection behavior. Withdrawal and related history/dependency policy remain separate. G4 must define locality, route/evidence validity and Local eligibility. D10 must use the eventual eligible Local resolver for Organizer selection. No FE, extraction, other copy direction, automatic Universal creation, migration, merge or deployment is included.
