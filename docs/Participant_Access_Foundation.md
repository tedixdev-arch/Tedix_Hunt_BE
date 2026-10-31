# Task 5A: Participant enrollment and checkpoint access foundation

Status: **smaller contract-and-persistence fallback; new enrollment and GPS grants remain disabled**.
Base: GitHub `main` at `4ec0f8e3bf4d650b859a5c5459afd5d65ab5d329`; PR #94 merged on 31 October 2026. This does not complete production Participant gameplay or all Task 5A acceptance criteria. Stop for ChatGPT PR review. Do not merge or deploy.

## Existing versus added

Existing: authenticated identities and account blocking; public Hunt-code resolution; HuntParticipant/Team models and composite Hunt foreign keys; published/active/paused lifecycle; Hunt-pinned snapshots; geographic fields; Creator-only challenge definitions; custom publication guard. Existing `HuntParticipant.enroll` could return no row when an overlapping INSERT lost an uncommitted conflict (its CTE SELECT used the old statement snapshot). It now uses a single conflict UPDATE/RETURNING, preserving UUID/join time and serializing duplicates. This model remains a trusted internal primitive, not public enrollment authorization.

Added: authenticated rejoin/context/checkpoint-status/proximity-request routes, persisted server-generated checkpoint UUIDs, snapshot pinning, durable per-member access/evidence schema, strict observation shape and a documented distance evaluator. Runtime responses explicitly report unresolved policies and disabled gameplay access. No Team creation, challenge delivery, attempt, score, leaderboard, completion, Organizer suspension control, FE change, publication enablement or proposed #94 gameplay route registration.

## Implemented HTTP contract

All four operations use existing bearer authentication/account checks, caller identity only, `Cache-Control: no-store`, and Hunt-specific membership checks. Professional roles alone never confer Participant membership. Existing authenticated guest identities may rejoin an already provisioned membership; these routes create no identities or guests.

| Operation | Behavior |
| --- | --- |
| `POST /api/hunts/{id}/participants/enroll` | Body `{}` for an existing authorized membership, or `{accessCode}` checked against that Hunt. Existing member returns 200 with stable identity/context. New member with valid code receives 422 `enrollment_policy_unresolved`; no-code outsider or wrong code receives 404. No enrollment is created by this HTTP operation yet. |
| `GET /api/hunts/{id}/participants/me` | Stable participant UUID/join date, lifecycle, pinned version, policy status, checkpoint UUID/kind/access state. No raw snapshot, challenge, answer, hint or other member data. Initializes the caller's access state atomically if absent. |
| `GET /api/hunts/{id}/checkpoints/{checkpointId}/access` | Returns only caller-scoped checkpoint status; UUID belongs to this Hunt and pinned snapshot. Reading a future checkpoint's locked status grants no access. |
| `POST /api/hunts/{id}/checkpoints/{checkpointId}/proximity` | Strict `{latitude,longitude,accuracyMeters,observedAt}` body. Validates authentication, shape, membership, lifecycle, identity and eligibility. Future checkpoints: 409. Missing saved geography: 422 `checkpoint_geography_unavailable`. Otherwise: 422 `proximity_policy_unresolved`. **No 2xx grant path exists.** |

Published and paused Hunts permit existing-member rejoin/context; only active Hunts may even request proximity verification. Draft, finished and cancelled Hunts reject access with 409 after access-code/membership checks. Unknown or inaccessible Hunts/checkpoints use 404. Invalid bodies use 400, invalid identities 401, unresolved policies 422. Error names are documented by runtime Swagger. Invalid GPS shape is rejected before the operation resolves checkpoint state; no target geometry is disclosed.

The existing opt-in abuse protection budgets cover authentication endpoints, not gameplay/enrollment attempts. This fallback adds no arbitrary attempt/rate policy and enables no new enrollment or GPS grant. Approve participant-scoped and code-lookup budgets before those operations are enabled; current code resolution has the pre-existing metadata-only exposure.

The runtime OpenAPI documents these four paths only. The separate proposal from #94 remains a proposal; challenge delivery, attempts, hints and progress operations are not implemented here. Existing Organizer/Supervisor detail and Admin authority remain separate.

## Enrollment decision D7

The saved access mode is `invitation_only`. #94 explicitly leaves invitation/enrollment transport and access-code authorization unresolved. No durable invitation table or approved rule says that knowing a code constitutes an invitation. Accordingly this fallback does **not** interpret code knowledge, a Hunt UUID, organization membership, or a professional role as permission to create a Participant enrollment. A code checks the requested Hunt; authentication still checks the caller; an existing HuntParticipant is the current authorization evidence.

New membership must wait for an approved invitation/eligibility rule and an authorized provisioning endpoint or transport. The existing model can seed trusted memberships, as the integration fixture does; that fixture is not evidence of publicly available valid enrollment. Public `GET /api/hunt-access/{code}` continues to resolve metadata only. No new invitation system, guest account or automatic Team is invented. Capacity, late enrollment and membership revocation/rejoin semantics remain future D7 decisions.

## GPS policy D1 and suspension D6

Only latitude [-90,90], longitude [-180,180], finite numeric values and nonnegative finite accuracy are accepted. `observedAt` uses a real canonical UTC timestamp with milliseconds (`YYYY-MM-DDTHH:mm:ss.sssZ`); impossible calendar dates, coercible strings, nonfinite numbers and unknown fields are rejected. This is a transport format, not a freshness policy. Syntactically valid stale/future/inaccurate observations never grant access; they receive the unresolved-policy denial. There is no permissive age/accuracy default or environment/request switch that enables grants.

The isolated evaluator uses Haversine great-circle distance with IUGG mean Earth radius 6,371,008.8 m and an inclusive radius boundary. It accepts explicit policy inputs for review and deterministic calculation tests. **It is not connected to runtime granting.** Proposed values for review: maximum age 30 seconds, no future observations, maximum reported accuracy 5 m, and conservative containment (`distance + accuracy <= saved radius`). Alternatives: 10-second freshness or a reviewed future-clock tolerance; 10 m accuracy; center-only distance with documented uncertainty. These accuracy, freshness and grant-policy proposals remain unresolved; approval of the checkpoint radius standard does not approve any of them.

The approved default for new TedixHunt checkpoints is **25 m**. This standard applies to new checkpoints; existing immutable Hunt snapshots preserve their stored radii, independently for each regular checkpoint and FinishPoint. Do not replace a stored radius or backfill historical snapshots with the new default. Creator/Organizer/Admin radius overrides and radius editing belong to a separate upcoming task and are not implemented here. This correction documents the approved standard without changing runtime behavior.

Original canonical Signal v1 has no saved geographic points. Its historical snapshots remain unchanged and receive geography-unavailable denial. Starter copies may contain saved geography/radius, but navigation-disabled or missing/ambiguous geography never produces an automatic grant. GPS accuracy, freshness, uncertainty and grant policy remain unresolved, and all GPS grants stay disabled.

Client GPS can be spoofed: even a future positive server evaluation will be an operational access rule, not proof of physical presence. No anti-spoofing service is introduced.

Organizer Hunt checkpoint suspension does not exist. Admin Local Template eligibility suspension is unrelated and is not reused. There is no Organizer override or suspension API here. All gameplay access stays false, including a row with persisted verification evidence. Before granting/delivery is enabled, define D6 revocation/resume/override/expiry behavior. Future writers must lock Hunt first and re-evaluate current suspension/lifecycle/membership for every grant and gameplay operation; they may invalidate evidence by clearing verification fields and resetting state in that transaction. Do not cache a verified row as permanent access permission.

## Persistence, identity and progression

Migration `030_participant_checkpoint_access` adds:

- Nullable `hunt_participants.access_snapshot_digest` with a scoped unique key. Existing members are not backfilled or re-identified.
- `hunt_checkpoint_identities`: server UUID, Hunt, SHA-256 snapshot fingerprint, server ordinal and regular/finish kind. Ordinal is internal mapping, never client authority. One mapping per Hunt/ordinal; distinct Hunts have distinct UUIDs even for identical snapshot JSON.
- `participant_checkpoint_access`: composite Hunt/member/checkpoint/snapshot foreign keys, durable access state and optional verification time/observation time/accuracy/distance/policy revision. Verified evidence requires all fields; nonverified states require them absent. No raw observation-coordinate history is stored.
- A Hunt UPDATE guard prevents changing pinned snapshot key/version/JSON after access identities exist. No historical Hunt or Template JSON is rewritten. Full-schema bootstrap contains the same DDL.

The server fingerprints PostgreSQL's JSONB text, checks the Hunt key/version against the saved JSON, maps authored regular order and the terminal, then binds state under one transaction. Both lifecycle updates and initialization serialize on the Hunt row; Participant locking follows. Duplicate enrollment uses existing unique membership constraints. A failed lookup/verification rolls back initialization as well. No partial state persists after a denied operation. Reads/resume use committed database rows; no browser storage authority exists.

Regular checkpoints must have ordered, contiguous saved checkpoint numbers. New terminal `role:terminal` is mapped last. The explicitly recognized canonical Signal v1 shape retains six regular entries plus its numbered seventh playable FinishPoint, without editing its JSON. Missing/ambiguous order, terminal or version fails closed. No Template lookup or client version/index selects the route.

The first entry initializes as `eligible_for_proximity`; all others are `not_yet_accessible`. `proximity_verified` is a separate persisted state with mandatory evidence, reserved for a future approved trusted writer. No HTTP route currently writes it. `gameplayCompleted:false` and `mayAccessGameplay:false` are explicit outputs, not inferred from proximity. No gameplay-completed database transition exists in this task. Finishing a GPS check cannot unlock later checkpoints. Future completion/quorum rules (D2) must be implemented before advancement; FinishPoint will need actual challenge completion as a playable checkpoint.

## Validation and next work

See [validation evidence](Participant_Access_Validation.md). Positive GPS calculation tests exercise explicit hypothetical policies only; a database fixture checks evidence persistence after a fresh app instance. Neither establishes real physical presence, approved runtime policy, successful HTTP GPS grants, or public new enrollment.

Subsequent work: approve D7 invitation/eligibility and identity lifecycle; approve D1 age/accuracy/uncertainty/grant validity; resolve D6 suspension/override and consistent lock order; capture verified Signal geography in a new artifact using the approved 25 m default for new checkpoints (preserve all stored radii in existing immutable Hunt snapshots); handle Creator/Organizer/Admin radius overrides in a separate upcoming task; implement policy-gated transactional evidence writes; then D2 Team/quorum/completion, D3–D5 scoring/assistance/privacy and D8 normalization/Legacy migration. Every future delivery/submission must consume current membership, source, lifecycle, checkpoint order, suspension and access state. Retain custom publication guards until that implementation and its security tests exist.
