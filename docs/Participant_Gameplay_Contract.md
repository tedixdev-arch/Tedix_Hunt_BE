# Task 5: secure Participant gameplay — contract proposal

Status: **contract only; not production gameplay; Task 5 is not complete**. Prepared 31 October 2026 (Europe/Bucharest). Base: latest GitHub `main`, `4e6cb521ba6ac930d28cd513935d83367ee80f91` (merged BE #93), verified via GitHub ref API. The checkout HEAD matches; local `origin/main` was stale and direct fetch failed because the execution proxy was unreachable. No runtime, schema, migration, FE, publication guard, merge or deployment changes.

The companion [OpenAPI proposal](Participant_Gameplay_Proposed.openapi.json) is a separate review artifact. Import it into Swagger Editor to inspect proposed operations. It is deliberately **not** registered in `/api/docs.json`: none of its operations exists yet. Existing endpoints remain documented by the runtime Swagger spec. Proposal fields and error names require contract review before Task 6 integration.

## Inspection and decision

| Area | Inspected evidence | Finding |
| --- | --- | --- |
| Lifecycle/access | `src/routes/hunts.ts`, `src/routes/huntAccess.ts`, `src/models/Hunt.ts`, `src/models/HuntContext.ts`, `src/routes/me.ts` | Organizer lifecycle transitions, public code resolution, authenticated context listing exist. Code resolution does not enroll. Participant gameplay routes do not exist. |
| Identity/enrollment | `src/middleware/auth.ts`, `src/models/HuntParticipant.ts`, `src/models/Team.ts`, migration 003 | Active bearer identity, idempotent model enrollment, Hunt-scoped Team membership and composite FK isolation exist. No enrollment or Team session HTTP operations, roster freeze or clue assignment protocol. |
| Progression/GPS/suspension | `src/app.ts`, `src/db/schema.sql`, migrations 001–029, `src/domain/creatorTemplates.ts` | Geographic positions/radii and authored order exist. No checkpoint visits, GPS verification, progression records or Organizer checkpoint suspension execution. Admin Local Template eligibility suspension is a different feature. |
| Personal/Team gameplay | `src/domain/customExerciseSchemas.ts`, `src/domain/customExercises.ts`, `src/domain/checkpointGameplay.ts`, `src/test/customExercises.ts` | All 22 canonical authoring schemas/relations exist; they validate definitions, not submitted attempts. No delivery, submission, hint or completion service. |
| Scoring/results | `src/domain/templates/signalClujNapocaV1.ts`, `src/domain/rewards.ts`, `src/routes/huntRewards.ts`, `src/db/schema.sql` | Snapshot scoring constants and reward configuration exist. No persisted attempt, score balance, leaderboard calculation, competition reset or Passport award execution. Reward configuration is not earned reward persistence. |
| Versions/approval/publication | `src/models/HuntTemplate.ts`, `src/models/OrganizerLocalTemplate.ts`, `src/models/PublishedUniversal.ts`, `src/domain/huntReadiness.ts`, migrations 016, 019–023, 027–029 | Immutable version ownership and Hunt snapshot selection; approval and publication authorities are distinct. Every custom-bearing Hunt remains unpublishable. |
| Legacy/FinishPoint | Signal v1, both starter factories and tests, `src/lib/swagger.ts` | Original Signal has six normal entries plus numbered seventh terminal puzzle; starter copies represent FinishPoint as unnumbered `role:terminal`. Preserve both without rewriting historical JSON. |
| Auth/rate limits/docs/tests | auth and abuse middleware/config, `src/lib/swagger.ts`, existing route/integration tests, package scripts | JWT type/account checks and opt-in authentication budgets exist. No gameplay attempt budget; HTTP harness needs local sockets; integration suites require `TEST_DATABASE_URL`. |

Read-only FE references: PRs [136](https://github.com/tedixdev-arch/Tedix_Hunt_FE/pull/136)–[142](https://github.com/tedixdev-arch/Tedix_Hunt_FE/pull/142), including descriptions, BE #93 and current `docs/evidence/Creator_Challenge_Library.md`. FE #137 establishes version-owned persistence; #138 distinguishes Legacy assignments from custom examples; #139–#142 concern authoring UX. They do not establish server scoring, GPS trust, shared completion or roster assignment. Creator simulation is not Participant authority. No FE files changed.

### Gap matrix (before implementation)

| Capability | Existing | Missing | Proposed change |
| --- | --- | --- | --- |
| Safe delivery | Minimal public access/context DTOs; custom snapshots withheld from supervisor-only Hunt reads | Challenge projection and access/progression enforcement | Explicit per-mechanic allowlists; resolve only Hunt snapshot, never latest Template |
| Answer validation | 22 closed Creator schemas and relational checks | Strict submission schemas, runtime correctness checks | Canonical response fields in matrix below; compare stored expected answer |
| Personal scoring | Authored snapshot constants | Transactional per-person attempts/balance/awards | Extend Hunt/Participant persistence after score policy resolution |
| Team scoring | Team membership isolation; authored Team constants | Shared attempts/completion, score beneficiary policy | Serialize on scoped Team challenge state; single completion/award |
| Completion | Hunt lifecycle status; terminal authoring | Personal/Team/checkpoint/Hunt completion requirements | Persist scope-specific state; FinishPoint runs both configured challenges |
| Publication | Definition validity, ownership, approval, fail-closed custom guard | Tested production capability registry | Keep guard; later require every occupied slot to pass complete capability checks |
| Legacy compatibility | Immutable Signal data/starter tests and historical snapshots | Server execution adapter and browser-state migration policy | Preserve flat data; explicit Legacy adapter; never treat Legacy kinds as modern Personal types |

### Why contract only

Implementing comparisons alone would leave progression, scoring, private clues and completion unauthoritative. Safe execution requires the product choices below and the absent persistence/access foundation. This is not a second Hunt engine proposal: future work extends the existing Hunt, HuntParticipant, Team and pinned snapshot model. No mechanic is enabled or declared secure by this PR.

## Blocking decisions and implementation dependencies

| ID | Decision to resolve | Evidence / consequence |
| --- | --- | --- |
| D1 | GPS access policy: accuracy/age/radius, spoofing tolerance, manual Organizer override, navigation-disabled checkpoints | Saved coordinates are not proof of a visit. Define persisted server access grants and their validity; every delivery/mutation must consume/check that state. No direct-answer bypass. |
| D2 | Personal vs Team stage ordering, participation quorum, absent/late members, who may submit shared answers, prerequisite for unlocking next checkpoint | Current Team membership has no runtime session/frozen roster. Stable participant UUIDs exist; durable item-to-participant assignment and reassignment policy do not. Never use client player indexes. |
| D3 | Team score beneficiary, starting balance, Personal penalty/bonus eligibility for all 15 types, FinishPoint overlap, tie/rank rules, competition reset vs persistent Passport | Signal stores numbers, not a generalized executor. Reuse snapshot rules after defining their application; do not assign arbitrary new scores or duplicate terminal and mission awards. |
| D4 | Attempts/skip limits, hint/solution release gates, hint penalties, whether solution/skip completes a challenge and affects awards | Signal has penalty constants but no server state machine. Default proposal exposes no assistance until policy is specified. Generic incorrect feedback only after accepted attempt; authored feedback/solution requires explicit release and review. |
| D5 | Which Team collections are private, when contributions unlock, assignment when roster size differs from 2–16 authored items, reconnect/replacement behavior | Distributed Information facts must be private. Other Team mechanics do not automatically require private content. Proposal conservatively withholds member contributions until policy approval. |
| D6 | Organizer checkpoint suspension authority, effect on in-flight attempts/GPS grants and resume | Existing Admin Template suspension is not checkpoint suspension. Define audited Hunt-scoped state and locking before enabling gameplay. |
| D7 | Enrollment/Team creation/join transport and access-code authorization; handling guest identity persistence | Only model operations exist. Do not turn knowledge of a Hunt UUID/code into membership or create Teams during answer submission. |
| D8 | Text normalization (trim/Unicode/case/whitespace), memory recall phase timing, number-line off-grid submission policy, Legacy session migration | Stored caseSensitive exists; Creator strings are preserved exactly. Align the existing browser checker read-only, document differences and get canonical policy; do not silently normalize, infer mathematics or import browser correctness. |

These are unresolved choices, not requests to approve a runtime change in this PR. Dependencies: product contract decisions → access/enrollment and checkpoint state → scoped attempt/score persistence → mechanic projectors/validators → real API/concurrency tests → capability-based publication → Task 6 FE adapter. Ship none of these by simply relaxing readiness.

## Proposed API and trust boundary

Reuse `/api/hunts/{id}`. Existing `GET /api/hunt-access/{code}` is public metadata only; `GET /api/me/hunt-contexts` requires bearer authentication; Hunt detail remains Organizer/Supervisor access, not a Participant challenge source. Existing Creator save/version/submit and Admin review endpoints continue to return full definitions only under their current authorization.

Proposed operations, all authenticated with existing `requireAuth`, all unavailable today:

| Method/path | Proposed meaning |
| --- | --- |
| `GET /api/hunts/{id}/checkpoints/{checkpointId}/challenges/{classification}` | Deliver accessible Personal or Team slot; return opaque challenge ID and pinned version plus allowlisted interaction and member-specific information |
| `POST .../challenges/{classification}/attempts` | Strict answer submission with required `Idempotency-Key`; no score/correctness/participant/Team ID from client |
| `POST .../challenges/{classification}/hints` | Idempotently release only the next authorized hint after policy checks; never arbitrary hint index or initial hints array |
| `GET /api/hunts/{id}/progress` | Caller-scoped persisted completion/score and accessible checkpoint IDs for reload/resume; no other members' clues or responses |

`checkpointId` is an opaque server-resolved identifier scoped to the Hunt snapshot, including terminal; it is not an array index supplied by FE. `classification` is `personal|team`. Allocate/map checkpoint identity without modifying snapshot JSON. Bind opaque challenge identity to Hunt, checkpoint, slot and exact custom UUID/owner (or Legacy adapter identity). Exact ID allocation belongs to persistence design; no ephemeral per-request identities. Check Hunt status, active account, enrollment, Team membership for Team operations, visit/access grant, checkpoint order, suspension and stage requirements for every operation. A role alone is insufficient. Participants who are also organizers still receive the safe projection on these routes.

Response allowlist: `challengeId`, `templateVersion`, `type`, `classification`, `schemaVersion`, `title`, `instructions`, mechanic-specific `interaction`, `playerInformation`, and completion status. Nested objects are closed. Never spread a checkpoint, `interaction` object or Creator definition into a DTO. For Personal mechanics the exact allowlisted interaction fields are those in the matrix; no answer object, correct ID, answer mappings, hints, solution, feedback, owner metadata or raw snapshot. Option IDs are legitimate public item references; never mark which ID is correct. Wrong guesses are not returned as expected answers. Narrative/instruction content still needs human approval: an allowlist cannot detect an author writing a solution in a title.

For Distributed Information return public `options` and only assigned `playerInformation.facts`, not the full facts collection, player count indexes or other members' assignment map. Shared Final Key initially returns `orderingInstructions` plus only the caller's authorized `playerInformation.contributions`. A submitted combined key may contain information players have intentionally shared; no response exposes the stored order/code. Other Team private collections require D5. No WebSocket/event infrastructure is introduced; resume/poll uses the same authenticated DTOs.

Initial delivery includes no assistance or feedback. Proposed hints operation returns only `{hint, ordinal}` after explicit authorization, persisted release and any configured score mutation in one transaction. Repeating the key returns the same hint without another penalty. No solution endpoint is proposed until D4 resolves release semantics; omit solutions everywhere for now. Do not derive a new penalty from number of attempts or invent hint costs. HTTP `Cache-Control: no-store` is required for private gameplay responses. Never log answer bodies, private clues, tokens or expected definitions; audit scoped IDs/outcomes only.

Strict error envelope `{error:string}`: 400 malformed/unknown fields, 401 invalid account/token, 404 inaccessible Hunt/checkpoint/challenge/membership (uniform concealment), 409 invalid Hunt state/progression/suspension/version/idempotency conflict, 422 unsupported gameplay/policy unresolved, 429 attempt budget (`Retry-After`), 500 generic internal error. Valid but incorrect answer: 200 with `correct:false`, authoritative completion/score. Feedback cannot include expected answer definitions. Recheck authorization even for a cached idempotency result. Gameplay budgets must use authenticated Hunt/participant scope and Team aggregate where appropriate; rate/attempt limits require D4 and operator configuration, not reuse login budgets by accident.

## Canonical mechanic coverage and proposed validators

All rows: existing definition validation/persistence **yes** (BE #93); new runtime delivery/submission/correct/incorrect/completion/scoring/resume tests **not implemented**; publication **blocked**. The response below is submitted player data, never expected-answer delivery. No answer schemas are changed. New submitted response DTOs intentionally omit server-only `caseSensitive`, target and tolerance. Collection membership/completeness and bounds apply before correctness. Invalid shape is 400; well-formed wrong answer is an accepted incorrect attempt.

| Mechanic | Safe public interaction (private additions noted) | Submitted `response` and correctness | Runtime coverage / publication |
| --- | --- | --- | --- |
| tap-pair | left, right | pairs: unordered complete bijection; compare each left→right | Not implemented / blocked |
| single-choice | options | optionId: valid option; exact expected ID | Not implemented / blocked |
| true-false | empty object | value: Boolean equality, no coercion | Not implemented / blocked |
| memory-card | card, revealDelayMs under D8 phase policy | value: text, authored case policy after normalization decision | Not implemented / blocked |
| number-line | min, max, step | value: finite bounded number; abs(value-target) <= stored tolerance; grid policy D8 | Not implemented / blocked |
| multiple-choice | options | optionIds: distinct valid IDs; set equality | Not implemented / blocked |
| match-columns | left, right | pairs: unordered complete bijection; compare mappings | Not implemented / blocked |
| drag-drop | items, targets | assignments: every item once; compare item→target, repeated targets allowed | Not implemented / blocked |
| fill-blank | blanks | values: every blank once; compare keyed strings under D8; stored schema has one value per blank, not invented alternatives | Not implemented / blocked |
| sequence | elements | order: complete permutation, ordered equality | Not implemented / blocked |
| find-mistake | steps, explanations | stepId AND explanationId must match | Not implemented / blocked |
| build-problem | pieces, slots | construction: distinct valid inventory IDs in slot order; exact stored sequence; no expression evaluation | Not implemented / blocked |
| number-pattern | terms, missingId | value: finite numeric equality | Not implemented / blocked |
| shape-pattern | terms, missingId, shapes | shapeId: valid ID equality | Not implemented / blocked |
| rule-discovery | examples, rules, predictionInput | ruleId AND predictedOutput equality; no mathematical inference | Not implemented / blocked |
| scrambled-word | public fields withheld pending D5; assigned contributions only | word: text equality using approved normalization/case policy | Not implemented / blocked |
| distributed-information | options; private assigned facts only | optionId: validate against full stored Team answer | Not implemented / blocked |
| hypothesis | decoderKey; assigned packets only pending D5 | value: authored expected text; decoder is display data | Not implemented / blocked |
| assemble-machine | frequencies; assigned contributions only pending D5 | frequencyId: valid expected choice, no invented construction engine | Not implemented / blocked |
| clue-synthesis | answerPattern; assigned clues only pending D5 | value: expected text; pattern is inert, never regex execution | Not implemented / blocked |
| filter-noise | assigned signals only pending D5 | trustedSignalIds: distinct valid IDs; expected set from complete challenge | Not implemented / blocked |
| shared-final-key | orderingInstructions; assigned contributions only | order: complete contribution permutation AND code: exact digit string; preserve leading zeros | Not implemented / blocked |

The OpenAPI proposal encodes all 22 closed submission and delivery shapes with stable item IDs and bounds from BE #93. Per-definition relations remain runtime obligations; OpenAPI cannot express snapshot membership, access grants or transactional correctness. It does not certify privacy policy approval.

## Transaction, persistence and version proposal

No migration is included. Reuse `hunts`, `hunt_participants`, `teams`, `team_members` and immutable `template_snapshot`; no mutable exercise library or replacement engine. Implementation will need minimal scoped tables for checkpoint access/state, challenge state, attempts/idempotency and stable private assignments, plus authoritative score/award persistence after D3. Exact migration/DDL is deferred until the state and score beneficiary contract is settled.

Required invariants for those tables:

1. Bind every state/attempt to Hunt and pinned snapshot version, checkpoint, classification and challenge identity. Composite FKs must prohibit cross-Hunt participant/Team references; use existing composite membership model. Validate stored custom UUID and owner against the Hunt snapshot, never a client version or latest Creator version.
2. Persist a unique completion per `(hunt, snapshot, checkpoint, classification, subject)`; subject is authenticated HuntParticipant for Personal, current Team for Team. Use separate/checked subject fields rather than nullable uniqueness that permits duplicates. Store Team membership epoch/assignment identity if D2 permits roster changes.
3. Within one transaction serialize a consistent lock order on Hunt execution/suspension state, checkpoint and subject challenge state. Resolve membership and access again under the transaction. Membership/suspension writers must use compatible locking. Insert attempt, validate, record completion and update score once before commit; rollback all on failure. Concurrent wrong attempts must also serialize first-attempt eligibility and penalties.
4. Idempotency is scoped to authenticated participant, Hunt, operation and challenge; same key and canonical request hash returns the original result after access recheck; same key/different data is 409. Unique keys and completion/award constraints protect different-key replay and simultaneous Team submissions. Retry after network loss cannot repeat penalties/awards. Define retention at least through Hunt settlement; don't delete attempt keys while replay can score. A fresh key for another wrong attempt follows D4, not automatic deduplication by answer text.
5. Stable assignments map stored item IDs to HuntParticipant UUIDs in the Team/Hunt/challenge scope. Persist once and return the same data on reload. Decide roster size/leave/rejoin policy before allocation. No client indexes, name parsing, round-robin on each GET or volatile roster order.
6. Completion and scoring are server outputs. Ignore no unknown field silently: reject `score`, `correct`, `completed`, `teamId`, `participantId`, `owner` and unexpected nested fields. Supplied templateVersion is a consistency precondition, never snapshot selection. New Template revision/copy IDs cannot answer an old Hunt.
7. Resume reads committed state. Team completion is shared and once-only; Personal progress remains per participant. FinishPoint checks configured Personal and Team requirements plus all prior required checkpoints before final Hunt completion/mission award. Historical Signal seventh entry is interpreted without renumbering stored data; new terminal remains unnumbered. Empty/unconfigured slots need explicit completion policy, never Signal fallback.
8. Competition score reset cannot remove Passport history or permit re-earning the same durable award. No historical snapshot/state backfill from untrusted browser results. D3/D8 must decide Legacy transition and durable award identity.

## Publication and compatibility gates

Keep `validateHuntForPublish` unchanged. Every one of the 22 mechanics remains blocked for Hunt publication. Creator save/submission/review eligibility continues as in BE #93; approval is not gameplay readiness. Later replace only the custom blanket check with an explicit `(type, schemaVersion, classification)` capability registry whose entries require definition validity, exact version ownership, projection, validator, score/completion integration and tested Team privacy. Every occupied slot, including FinishPoint, must pass; unknown/mixed unsupported versions fail closed. Do not change Creator approval, published version pins, Local selection authority, or immutable snapshot triggers.

Legacy Signal flat fields (`correctAnswers`, `teamAnswer`, hints/solutions, named demonstration contributions) cannot be delivered wholesale. A future adapter must use its own explicit safe projection/validator while sharing the same attempt/scoring persistence. No aliasing `hidden-rule` to `rule-discovery`, no modern schema inference, no default answer from a platform starter when a saved field is absent. This contract does not retrofit security into an existing browser that already embeds canonical answers; Task 6 must remove that authority before production claims.

## Required implementation acceptance tests (not supplied as passing gameplay tests)

Use actual Express auth and PostgreSQL persistence, disposable databases and all numbered migrations. No helper-only or mocked-DB result establishes production acceptance.

| Security requirement | Required test/outcome |
| --- | --- |
| Answer/ID/hint leakage (1–3) | Seed distinct secret sentinels in expected answers, mappings, feedback, hints/solutions, owner metadata and unknown Legacy fields. Recursively verify initial/detail/progress/error responses and all 22 allowlists; public option IDs allowed, correct designation absent. |
| Private clues (4) | Two authenticated Team members get disjoint assigned secrets; outsider, reconnect and roster-change cases; shared-final-key order/code never delivered. |
| Hunt/Team authorization (5–6) | Anonymous/blocked/retired, unenrolled and other-Hunt/Team identities cannot read, submit or replay cached results. Privileged role alone gives no gameplay membership. |
| Future/suspended checkpoint (7–8) | Direct POST before GPS/access, out of order and racing suspension returns denial with no attempt/score changes. |
| Duplicate/concurrent/replay (9–11) | Same-key retry, changed-payload key, different-key duplicate correct, parallel different members and parallel incorrect/correct; one completion/award and deterministic first-attempt penalty/bonus; rollback on injected write failure. |
| Cross-Hunt/version (12–13) | Same Template in two Hunts, newer revision/copy and valid foreign UUID/version all denied without snapshot mutation. |
| Malformed/client authority (14–15) | Unknown keys, wrong types, Boolean coercion, duplicate IDs, missing mappings, oversized/deep input, nonfinite/out-of-range values; score/correctness/completion fields rejected at all levels. |
| Unsupported publication (16) | Every mechanic blocked today; later unknown/schema-incomplete/mixed supported+unsupported slots and terminal denied; preserve approval and immutable pins. |

For **each of the 22 rows**, future tests must cover valid delivery, malformed and well-formed incorrect submission, correct submission, completion, scoring, refresh/resume and absent secret fields. Additional real-path cases: Personal and Team FinishPoint, all-requirements final completion once, mission and terminal award overlap, Hunt lifecycle pause/finish/cancel, GPS accuracy/age, suspension/resume, membership changes, hints/solution penalties, new Template revisions and immutable old Hunts, Legacy Signal adapter, leaderboard/reset and persistent Passport regression. Existing authoring tests are evidence only for persistence, not these gameplay paths.

## Task 6 FE integration requirements

Wait for reviewed/implemented contract and deployed capability support. Keep custom publication warnings. Use backend challenge IDs and pinned versions; never fetch Creator definitions, decide correctness, mutate authoritative scores, submit roster indexes, synthesize missing fields from Signal, or send completion flags. Submit only canonical response shapes with a new idempotency key per deliberate attempt and retain the same key/body for transport retry. Handle 409 by reloading authorized state; honor 429; render returned text as text. Resume from backend progress and per-player DTOs, not localStorage authority. Team sharing is human collaboration until existing transport requirements are resolved; no new real-time infrastructure is required here.

## Validation

See [Task 5 validation report](Participant_Gameplay_Validation.md) for commands, observed results and infrastructure limitations. No gameplay integration pass is claimed. Stop for ChatGPT review of the contract-only Draft BE PR.
