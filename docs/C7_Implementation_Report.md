# C7 — Organizer Local Template eligibility and selection implementation

Review target: `main` at `c0b4dbd` (merged C7 contract, PR #88).
Backend implementation for Draft PR review only. Do not merge or deploy as part of
this delivery. The approved C7 contract is unchanged; no frontend work is included.

## Result and changed files

An active non-guest Organizer can discover exact independently approved Creator
Local artifacts for a selected Country/Locality, inspect an answer-free preview,
and explicitly capture one into an existing authorized draft Hunt. Residence and
source Creator ownership do not restrict selection. Replacement candidates leave
the previous authority available until independent approval advances the pointer.

- `src/models/OrganizerLocalTemplate.ts`: one shared fail-closed resolver, coherent
  discovery statement and single-client transactional selection. Uses the exact
  pointer or permitted historical approved submitted pin; never latest/MAX or an
  arbitrary review. Retained evidence does not depend on today's owner/reviewer roles.
- `src/routes/organizerLocalTemplates.ts`, `src/app.ts`: the two Organizer GETs and
  explicit Hunt PUT, strict validation, filter-scoped cursor, safe allowlists,
  private/no-store responses (including authorization failures), OpenAPI documentation.
- `src/domain/huntTemplates.ts`: extracts the existing nested geographic allowlist
  for reuse; legacy approval/classification resolution remains unchanged.
- `src/db/migrations/028_hunt_local_template_source.ts`, `src/db/schema.sql`:
  additive source columns, complete-pair check, restrictive exact-version FK and
  source-integrity trigger. No backfill or authority/evidence rewrite.
- `src/models/Hunt.ts`, `src/routes/hunts.ts`: additive response mapping, conditional
  legacy source protection, publish readiness under the Hunt lock. The mapper
  normalizes PostgreSQL DATE values to the declared YYYY-MM-DD string so persisted
  dates can pass the existing readiness rule; no new publish/start eligibility gate.
- `src/models/HuntTemplate.ts`: actor-account locks precede Template locks for
  version insertion, approval, request-changes and suspension; suspension's existing
  persisted Admin capability lock also moves before Template acquisition.
- `src/db/organizerLocalTemplate.integration.test.ts`: disposable PostgreSQL C7
  acceptance and deterministic concurrency coverage. Existing migration, model,
  route and classification tests are updated for additive fields/query ordering.

## API and schema

| Operation | Behavior |
| --- | --- |
| `GET /api/organizer/local-templates` | Required `countryCode`, `localityId`; default limit 20, range 1–50; opaque validated filter-scoped cursor; immutable key/ID order; no count. Returns only contract metadata and saved locality pair. |
| `GET /api/organizer/local-templates/{templateId}/versions/{version}` | Required same filters; only current exact eligible authority; nested geographic configuration allowlist and separate current public Locality. Ineligible/missing/stale artifacts share 404. |
| `PUT /api/hunts/{id}/local-template` | Only `templateId`, positive PostgreSQL INTEGER `version`, `countryCode`, `localityId`. Persisted Organizer plus Hunt organizer authority, draft-only; complete server source capture. |

Discovery validates Country and Locality context in the same SQL statement snapshot
as identity, exact version, evidence and live geography. Unsupported Country is
400; missing/wrong-country Locality 404; inactive Locality 409. Details cannot read
arbitrary historical versions. No Creator-private metadata, review evidence,
provenance, suspension reasons or gameplay answers are projected.

The Hunt source tuple is `template_id`, existing `template_key`, `template_version`,
`template_snapshot`, plus `template_locality_id` and `template_locality_snapshot`.
The additive API names are `templateId`, `templateLocalityId`,
`templateLocalitySnapshot`. Complete content and saved labels are copied exactly;
current registry text never replaces approved source text. The locality metadata
is a sibling of content, never merged into it. Legacy/history retain NULL metadata.

The check rejects incomplete tuples. A composite restrictive FK retains the exact
Template/version; a restrictive Locality FK retains geography identity. The trigger
requires key/content/locality to equal one immutable Creator Local version,
prevents clearing an established Local source, and freezes it after draft state.
Updates that leave the tuple unchanged do not consult current live eligibility.

## Actual transaction and lock order

Selection uses one PostgreSQL PoolClient, BEGIN through successful COMMIT:

1. `users` actor `FOR SHARE`, recheck active/non-guest; authoritative Organizer
   `user_roles` row `FOR SHARE`. Account state and capability cannot be revoked
   through commit, even if middleware/JWT authentication happened earlier.
2. Hunt `FOR UPDATE`, then its exact organizer `hunt_roles` row `FOR SHARE`;
   validate existence, Hunt authority and fresh draft status after waiting.
   Parent-before-child agrees with Hunt deletion/cascade ordering.
3. Selected Template identity `FOR UPDATE`; read exact authority/evidence/binding
   in a fresh statement after any identity writer commits.
4. Saved Country `FOR SHARE`, then exact Locality `FOR SHARE`; read and run the
   same resolver again after waits. Check active state, membership and numeric
   coordinates, expected version and requested pair. Descriptive drift is allowed.
5. One UPDATE replaces the entire source tuple; COMMIT, including deferred
   constraints, must succeed before returning the Hunt.

Account blocking/retirement already acquire the `active-admin-invariant` advisory
lock when applicable, then `users FOR UPDATE`, before role/session changes.
Selection never acquires that advisory lock, so it cannot form a reverse dependency
on it. Non-Admin capability removal deletes only its `user_roles` row; Admin removal
uses the advisory invariant and then deletes its role row without taking Hunt or
Template locks. These deletes conflict with selection's retained role lock.
Provisioning/application grants lock the account before adding capabilities.
Existing Hunt role assignment inserts new role rows; no application Hunt-role
revocation path acquires Template/account locks after Hunt-role rows.

Template operations that insert versions/reviews or suspend now lock the actor's
account before Template acquisition, avoiding a Template → actor dependency with
selection and queued account writers. Suspension additionally protects the Admin
role before the Template. Initial draft insertion creates a new identity, so no
committed Hunt selection can contend for it. Submission/draft deletion do not
acquire an actor row lock after acquiring an existing Template. Universal copy
already protects its actor before locking the source identity. No Template writer
acquires a Hunt lock. Operational Template/geography order remains Template →
Country → Locality; catalog changes never lock Templates or Hunts.

Legacy draft PATCH is a conditional UPDATE, acquiring the Hunt row lock and
rechecking draft state; template replacement additionally requires
`template_id IS NULL` in the UPDATE predicate. A losing concurrent legacy write
returns `template_selection_conflict`, never overwrites C7 content. Setup-only
PATCH remains available. Publish rechecks persisted readiness after `FOR UPDATE`;
selection-first and publish-first paths serialize. Other lifecycle conditional
updates retain their existing semantics.

All failures roll back and release the client. There is no automatic retry layer;
deadlock/serialization/database failures abort the entire transaction rather than
reusing any prior authority or choosing another version.

## PostgreSQL acceptance evidence

Tests use PostgreSQL 17 in a disposable local container, independent disposable
databases, real Express HTTP/model paths and separate database connections.
Race tests use held row locks, advisory trigger gates and observed
`pg_blocking_pids` waits; they do not use sleeps or replace domain queries with mocks.
Existing unit mocks remain unit tests, not substitutes for PostgreSQL acceptance.

| C7 §7 | Evidence |
| --- | --- |
| 1 | Country/search reuse, exact authority list/detail, nested answer/private-data exclusion, full snapshot success and preserved settings. |
| 2 | First draft/submitted/changes-requested denial; v1 continuity at A across replacement states; approval switches to B; stale A confirmation conflicts. |
| 3 | Suspension audit retained through replacement approval and registry reactivation; no reinstatement. |
| 4 | Pre-027 bound independent historical pin succeeds without read-side capture; unbound, evidence-less, self-review, missing and unresolvable pins fail closed and remain unchanged. No latest fallback. |
| 5 | Two countries/same-name distinct UUIDs, exact filters, wrong-country/unknown/proposal-like UUID rejection, unsupported Country, empty active catalog, pagination scope and validation. |
| 6 | Latitude/longitude/country drift and inactivity exclude; text rename retains saved labels and separately returns current context. Malformed/partial immutable bindings are rejected by existing database constraints; missing current rows are also protected by restrictive FKs. |
| 7 | Exact ID/version and complete server content/pair capture; forged content/key/settings/snapshot fields and invalid INTEGER versions rejected; UUID case variants work; no newer version substitution. |
| 8 | Approval, suspension, deactivation, material correction and rename against selection in both acquisition orders; exact old commit or prescribed fresh conflict. |
| 9 | Competing selections; both orders of legacy PATCH and publish; write and deferred-commit failure injection; unchanged old tuple/settings on error and subsequent pooled operation success. |
| 10 | Participant/Creator-only/Admin-only/guest/blocked/retired/revoked denial; multi-role success; account block/retirement and capability/Hunt-role revocation in both acquisition orders; Template actor-before-identity lock checks against account blocking. |
| 11 | Other Hunt organizer, organization-only member and Supervisor denied before source lookup; source ownership confers no Hunt role. Existing private authoring/initial organization access suites remain passing. |
| 12 | Classified Local/Universal never enter legacy list/geography/templateKey paths; legacy-to-Local and protected C7 source; existing Universal publication/copy, category-null and Signal suites pass. |
| 13 | Draft/published/active/paused/finished/cancelled snapshots survive later candidate/approval/suspension/catalog changes; saved Hunt publish/start still work after suspension/inactivity; Participant access projection unchanged. |
| 14 | Migration upgrade/rerun/fresh parity for columns, constraints, trigger and function; direct SQL partial/forged/cleared source rejection; deletion restrictions; additive historical NULL fields. Compiled CLI independently applies all 28 migrations and reruns with no work. |

Final verification on Node 24.19.0 / PostgreSQL 17:

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS, exit 0 |
| `npm run build` | PASS, exit 0 |
| Focused PostgreSQL set (8 suites) | **248 passed, 0 failed, 0 skipped** |
| Complete `npm test -- --reporter=dot` with TEST_DATABASE_URL | **1,255 passed, 0 failed, 0 skipped; 60 files passed** |
| New C7 PostgreSQL suite (included above) | **89 passed, 0 failed, 0 skipped** |
| Compiled `npm run migrate` on separate disposable database | **28 applied; second run: no migrations to apply** |
| Fresh-schema parity and SQL guards | PASS in C7 PostgreSQL suite |
| `git diff --check` and unchanged approved contract | PASS |

Focused command (TEST_DATABASE_URL points only to disposable local PostgreSQL):

```sh
npm test -- \
  src/db/organizerLocalTemplate.integration.test.ts \
  src/db/localTemplateApproval.integration.test.ts \
  src/db/localTemplateAuthorityGuards.integration.test.ts \
  src/db/templateLocalityBinding.integration.test.ts \
  src/db/templatePublication.integration.test.ts \
  src/db/geography.integration.test.ts \
  src/db/migrate.test.ts \
  src/routes/huntTemplates.integration.test.ts --reporter=dot
```

These are executed results, including Universal/Signal/legacy regressions, rather
than historical totals from earlier implementation reports. An initial sandboxed
run lacked socket/listen permission and database configuration; the final results
above are complete reruns with those environment requirements satisfied.

## Scope and remaining limitations

No frontend, provider calls/storage, runtime gameplay, reinstatement, historical
backfill, automatic replacement, deployment or rollout is included. Eligibility
does not certify route safety. Discovery remains advisory and requires revalidation
on every selection, including repeat selection of an identical artifact.

The list resolves a locality's inventory within one coherent statement and applies
pagination to eligible results in memory; query cost grows with that locality's
inventory. No large-inventory performance claim is made. No automatic transaction
retry or lost-response idempotency guarantee is added, as allowed by C7.

The existing C6b-5 tests emit a pg@9 concurrent-client-query deprecation warning;
current pg@8 tests still pass. No suite is suppressed. Repository commands that
need network/listen/local Docker access require the managed executor's socket
permission; tests were rerun with that access and TEST_DATABASE_URL configured.
