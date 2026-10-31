# Task 5B: checkpoint radius configuration

Base: GitHub main `0493e7c7faf290ecedfb319f3257e09d6ddb53d8`, including merged #95. Draft BE PR only. Stop for ChatGPT review; do not merge or deploy.

## Existing and new behavior

Existing `configuration.checkpointPositions[].radiusMeters` and `configuration.finishPoint.radiusMeters` remain the authoring fields. Normal radii accept finite numbers in the existing 5–500 m envelope; FinishPoint retains integer metres in that envelope. Explicit 5, 9, 101 or 500 m values remain valid. No new final product range is approved: the proposed **10–100 m remains unresolved**, so this task retains the existing compatibility validation infrastructure.

Previously every supplied geographic point required an explicit radius. New immutable Creator saves now fill an omitted radius from the previous version's same checkpointNumber (or FinishPoint); otherwise they persist the approved **25 m** default. Coordinates, names and checkpoint completeness remain required by the existing draft/submission rules. Null, strings, Booleans, nonfinite or out-of-envelope numeric values fail validation; missing radius alone is allowed. FinishPoint still rejects fractions. The write helper never changes the caller object or runs on reads, submission, approval, historical versions, or migration. Removing a point does not invent geography. Reusing a number in a later authoring version treats it as that version's corresponding checkpoint; new numbers default to 25 m. No new checkpoint-ID authority is accepted from clients.

Creator edits still append an immutable next version, follow the existing draft/submission/review/republication lifecycle, and cannot update an approved row. Admin radius editing is a narrow new operation on Creator-owned **Local drafts only**: it appends a radius-only revision under the original owner, retaining locality and content. It cannot modify submitted/approved versions or approve the new revision. Existing owner/self-approval and independent Local review rules remain in force; no generic Admin content or active-Hunt mutation capability is added.

## Persistence and execution authority

Migration `031_checkpoint_radius_configuration` adds nullable `hunts.checkpoint_radius_configuration` JSONB and a guard trigger. Bootstrap schema contains identical DDL. **No historical backfill or JSON rewrite** occurs. Existing immutable Hunt snapshots and previous checkpoint identity/digest bindings remain untouched.

The new field is the Hunt's effective radius execution configuration:

```json
{
  "checkpointPositions": [
    { "checkpointNumber": 1, "radiusMeters": 37 },
    { "checkpointNumber": 2, "radiusMeters": 25 }
  ],
  "finishPoint": { "radiusMeters": 43 }
}
```

Local selection and legacy approved-template selection initialize it from the exact selected version's saved geographic points. Missing radius on a point in a newly selected Hunt configuration resolves to 25 m; missing geography stays missing. `template_snapshot` remains the exact complete approved source artifact, protected by the **unchanged** migration 028 equality guard. Organizer changes affect only the separate execution configuration, never Template versions or source JSON. Selecting a source again replaces its configuration and discards previous source-specific overrides. Ordinary unrelated setup changes preserve it.

Organizer patches resolve under the Hunt row lock. Effective rule: authorized saved Organizer value, otherwise selected-version radius, otherwise 25 m for a new configuration's geographic point. A patch is sparse: omitted checkpoints retain their effective values. There is no implicit reset or dynamic Template lookup. Example: source CP1=37, CP2=25, Finish=43; overriding CP1=63 and Finish=74 yields 63/25/74, while both the source Template and `template_snapshot` remain 37/25/43. A later approved Template revision affects only a later explicit selection/new Hunt.

Existing setup APIs are draft-only. This implementation therefore freezes execution radii at **publication**, earlier than start. Published, active, paused, finished and cancelled Hunts all reject ordinary radius edits. The DB trigger also rejects any radius change after draft or after Participant checkpoint identities exist. No unpublish or emergency bypass is introduced. Snapshot source and execution configuration are read in the same locked row; Participant snapshot digest includes both for newly configured Hunts. Historical null-configuration rows keep the exact original #95 fingerprint. The server UUID identity mapping, eligibility checks and saved radius semantics remain scoped to that pinned execution configuration. Coordinates always come from the source snapshot.

## API and permissions

Existing Creator endpoints remain `POST /api/creator/templates` and `POST /api/creator/templates/{key}/versions`, with full existing content envelopes. Their only change is omitted-radius persistence/defaulting. Validation retains existing 400 errors (`invalid_input` / `invalid_template_content`) rather than creating a new subsystem.

| Caller | Editable Local Template | Hunt radii |
| --- | --- | --- |
| Creator | Own eligible candidate; append immutable next version through existing save API | Only with Hunt-specific Organizer assignment |
| Organizer | No source mutation | Own assigned Hunt, draft only |
| Admin | Radius-only revision of an eligible Local draft through the endpoint below; original ownership retained | No global bypass; requires Hunt-specific Organizer assignment |
| Supervisor / Participant / other Creator | No additional authority | Denied |
| Anonymous / blocked / retired / privileged guest | Existing authentication/capability denials | Denied |

`PATCH /api/hunts/{id}/checkpoint-radii`:

```json
{
  "templateKey": "saved-local-key",
  "templateVersion": 1,
  "radii": {
    "checkpointPositions": [{ "checkpointNumber": 1, "radiusMeters": 63 }],
    "finishPoint": { "radiusMeters": 74 }
  }
}
```

Requires existing bearer auth and Hunt-specific Organizer assignment. The key/version precondition refers to the selected Hunt source, never current catalog approval. Returns the existing Hunt DTO with additive `checkpointRadiusConfiguration`. Rejects unknown fields, empty patches, duplicate numbers, invented checkpoints and unknown geography. Errors: 400 `invalid_radius_configuration`; 401 `unauthorized`; 403 `forbidden`; 404 `not_found`; 409 `invalid_hunt_state`, `template_selection_stale` or `execution_configuration_pinned`; 422 `checkpoint_geography_unavailable`. Sparse concurrent updates merge against the latest locked execution configuration, preventing lost disjoint edits. Selection/publication and access initialization use the same Hunt lock.

`PATCH /api/admin/templates/review/{key}/checkpoint-radii` accepts `{version, radii}` with the same sparse radius shape. `version` must be the latest saved draft version. The server generates the next version/content; caller cannot supply owner, source, coordinates, status or a complete replacement snapshot. Returns `{template, version}` from existing immutable version persistence. Errors: 400 `invalid_radius_configuration` or `invalid_template_content`; normal auth errors; 404 `not_found`; 409 `template_not_editable` or `template_version_not_latest`. Concurrent same-version patches produce one new version and one conflict. Existing approval is separate.

Runtime Swagger documents only these implemented additions and the updated existing request/response schemas. No proposed gameplay delivery, completion or attempts operation is registered.

## GPS and progression boundaries

All GPS grants remain disabled. Radius is distance configuration, separate from device accuracy, observation age, progression eligibility and operational suspension. No accuracy-based enlargement, hypothetical 5 m accuracy/30 s freshness defaults, expiry or suspension policy is adopted. These remain unresolved, as do audited active-Hunt emergency changes.

Overlapping circles are allowed, including identical coordinates. No distance-between-centers or artificial walking requirement exists. The #95 access foundation still exposes only the first eligible checkpoint; future checkpoints stay locked, verification never completes gameplay, and there is no completion/advance writer. Future progression must require a fresh eligible observation after unlocking; being already inside the next circle must permit immediate verification once approved GPS policy is implemented. This PR cannot exercise an unimplemented completion path and does not claim that acceptance.

## FE integration (read-only inspection; no FE changes)

Read current FE `docs/F7_FE_03_06_Implementation_Report.md` and `docs/Organizer_Geographic_Preview.md` through GitHub. Existing Creator saves send complete immutable versions and rehydrate backend-normalized content; continue doing so. Current geographic previews read source `templateSnapshot.configuration` and must explicitly overlay returned `checkpointRadiusConfiguration` for effective execution circles. For historical null configurations preserve source radii/missing fields without applying 25 m on reads. Do not change source Template displays to show Organizer values.

New-point authoring should show 25 m, retain explicit saved values, keep the current compatibility bounds until Owner approval, expose FinishPoint independently, send source key/version with Hunt patches, and handle 409 by reloading selected setup. Radius controls are draft-only. Existing custom gameplay publication warnings and GPS-disabled UI remain required. No deployed or real-device FE acceptance is claimed.

## Validation

The real Express/PostgreSQL suite in `src/routes/checkpointRadius.integration.test.ts` covers defaults, Creator/FinishPoint customization, source inheritance, Admin revisions, unauthorized changes, approved/submitted immutability, historical Signal snapshots, numeric rejection, overlapping coordinates without grants, disjoint concurrent setup, a publication-lock race, concurrent Admin revisions, later-version/Hunt isolation and the actual custom gameplay publication guard with otherwise complete setup. Existing database tests also compare pre-migration history, all Signal variants, immutable source equality and publication behavior. Nonfinite JS numbers are checked independently because JSON transport cannot represent them.

Reproduce with a disposable PostgreSQL CREATEDB role: `TEST_DATABASE_URL=... npm test`, `npm run typecheck`, `npm run build`, then `TEST_DATABASE_URL=... node docs/validate-participant-access.mjs`. The checker applies all 31 compiled migrations, repeats with zero applied, bootstraps a separate full schema, and validates runtime Swagger references and disabled gameplay registration. Results are recorded in the PR description.

Observed validation: full BE suite **68 files / 1,500 tests passed, zero skips**; final focused radius/access rerun **30 tests passed**. Typecheck, build and diff checks passed. Compiled migration check: **31 applied, repeat zero**; independent full-schema bootstrap passed. Runtime Swagger: **76 paths**, two implemented radius operations, all local references resolved and proposed gameplay operations absent. A disposable `postgres:17` container on localhost port 55436 supplied test databases; no deployed database was used. The existing pg concurrent-query deprecation warning remains unrelated to this change.

Direct Git transport could not reach the inherited proxy. GitHub connector reads supplied exact current-main files; the restored local base tree matched upstream tree `a41478fd762669dbba740c3e8933661e57756ff3`. The PR commit is created with actual upstream main as its sole parent; the temporary local restoration commit is excluded. Delivered remote tree is checked against the locally tested tree.
