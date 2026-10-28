# F7/C3 — Published Universal authority and shared Creator library

Based on main `d89bc06c48aa21d5660803294bc0cfe3ac786850`, including merged #75, #76 and #77. Inspected the F7 proposal, C1, C2, schema and migrations 018–022, approval transactions, Creator authorization, Organizer resolvers and Hunt snapshots before implementation. Also inspected FE architecture plan (blob `5aab1a71632a274377a3c6fc30d293dc649ed17c`), particularly F7 → G4 → D10 and staged workstreams. This request authorizes C3; older C2 statements reserving publication describe that earlier slice.

## Exact published authority

No migration, new state, table, pointer or release subsystem is needed. The existing `hunt_templates.submitted_version` is the single exact pin. Independent Admin approval locks the identity, updates status to approved and inserts its exact review decision in one transaction. After commit, an approved Universal is automatically visible to every authorized Creator; no owner action or second release is needed.

The resolver requires category universal, Creator origin, approved status, the version joined on `(template_id, submitted_version)`, and an approved review at that exact pair with reviewer different from original Creator. Historical approved status without evidence fails closed; no fabricated evidence/backfill. Review primary key and version uniqueness produce one product per identity. Never use latest/MAX(version). C1 already prevents classified content updates and identity/category/ownership changes; approval evidence and source restrictive FKs remain intact. This does not claim SQL prevents privileged deletion/rewriting of all review records; normal API transitions preserve existing evidence and approved records are not editable/deletable.

The external `publishedReference: { templateId, version }` identifies the exact immutable artifact, matching C1 source identity/version provenance. It is not a new publication ID. `id` is the product UUID; `key` is its existing stable key. Creator attribution includes durable id and current name only (possibly null/anonymized after retirement); email and account details are excluded. Attribution is not snapshotted public profile history.

## Authenticated read API

- `GET /api/creator/universal-library` returns `{ items: [{ id, key, displayName, theme, creator: { id, name }, publishedReference: { templateId, version } }] }`, sorted by key. It returns no content or version history.
- `GET /api/creator/universal-library/{key}` returns the same product fields plus the exact approved `content` snapshot for future adaptation. Unknown/private/nonpublished/Local/legacy keys all return 404. Query parameters do not select historical versions; `version=1` cannot override the current pin.

Both routes use existing authentication and persisted active non-guest Creator capability, including combined roles. Admin-only, Organizer-only and Participant-only accounts are denied; JWT role claims cannot grant access. Revoked capabilities are reloaded on each request; blocked/retired accounts fail authentication. Shared content intentionally includes approved gameplay, puzzles and answers needed for future Creator adaptation, but never owner workspace records, earlier versions, reviewer identity or Admin account/email metadata. Author-supplied approved content remains content, not server-owned review metadata. Ownership and authoring routes remain owner-scoped.

The separate route namespace preserves legacy Template keys (including `library`) and all existing starter/authoring paths. No copy/write API is added.

## Compatibility and future concurrency

Organizer catalog, geography and Hunt selection still use unchanged `category IS NULL` gates: Universal and Local remain unavailable even after approval. No historical classification or Signal changes. Existing Local copies, provenance, version/review records and Hunt snapshots are untouched. Universal approval certifies reusable content, not a physical route or G4 Local eligibility.

C4 must accept an expected exact published reference, re-resolve the authoritative product server-side, compare both identity/version and reject stale selection rather than silently copy a different artifact or offer historical fallback. That recheck, source snapshot and Local identity/version/provenance insert must be one transaction, serializing the source identity against future publication changes (C1 source binding already takes a source share lock). Persist source template/version/Creator and approved decision using C1 FKs; destination category/owner and content identity remapping are server-owned. A prior detail read is not authorization for a later copy. C3 does not implement this transaction or promise an API shape/error code for C4.

C5 must explicitly decide how an owner's draft revision coexists with a published product and how independently approved replacement becomes authoritative. C3's status/pin mapping must be revisited if status becomes revision-workspace state; do not infer that a submitted revision withdraws existing publication. Withdrawal, dependency retention, stale-copy behavior during withdrawal and approval-history policy remain unresolved; no withdrawal mechanism or revision/republication path is silently added here. G4 still owns route/location identity, evidence, validity, safety, Local approval eligibility and controlled legacy rollout; D10 selection and deployed supply-chain E2E follow. No merge/deployment or Participant runtime changes.

## Changed files

- `src/models/PublishedUniversal.ts`: exact evidence-backed resolver and safe product projection.
- `src/routes/creatorUniversalLibrary.ts`: Creator-only read routes and OpenAPI.
- `src/app.ts`: register the isolated namespace.
- `src/routes/creatorTemplates.integration.test.ts`: C3 disposable PostgreSQL/HTTP coverage alongside C2 compatibility checks.
- This document: authority, API, concurrency and scope contract.

## Verification

Dedicated disposable PostgreSQL 17 container on local port 5543; unique suite databases run baseline/all migrations through 022 and are dropped. No live database accessed.

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `TEST_DATABASE_URL=… npm test -- --reporter=dot`: **53 files, 1,029 tests passed, zero skips** (43.75 seconds).
- Focused Creator PostgreSQL suite: **11 tests passed**.
- `git diff --check`: passed.

C3 coverage verifies automatic independent approval visibility across Creator accounts, self-approval denial, draft/submitted/changes-requested invisibility, one product per identity, exact v2 despite an internally inserted unapproved v3, safe projections and original Creator attribution, other-owner workspace privacy, approved Local/legacy and evidence-free historical status exclusion, ignored historical-version query override, and authentication/capability rejection including revoked roles, multi-role users, guests and blocked/retired accounts. Existing C2 tests verify classified Organizer catalog/geography/direct Hunt selection exclusions; full Signal, historical review, C1 provenance and Hunt snapshot regressions passed.

An initial full run overlapped the namespace move and failed the C3 list URL assertion; the finalized isolated routes then passed the focused suite and full suite above. No deployment or deployed E2E is claimed.
