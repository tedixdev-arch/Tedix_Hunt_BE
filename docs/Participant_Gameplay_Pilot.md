# Participant gameplay — pilot Solo implementation (provisional)

Status: **implemented locally for review, not approved by the Product Owner.** Policy revision `pilot-solo-2026-11`.
Every value below is a provisional default taken from the "minimum proposal" column of
[Participant_Gameplay_Decisions.md](Participant_Gameplay_Decisions.md). Replace them when D1–D8 are decided.

## What a participant can do

1. Join with the Organizer's code (existing D7-A admission), as a guest (optional display name) or account.
2. `GET /api/hunts/:id/participants/me/play` returns the mission, server score, checkpoint progress and the
   current stage: `waiting` (Hunt not active), `navigate`, `personal`, `team` or `finished`.
3. Arrive: `POST /api/hunts/:id/checkpoints/:checkpointId/proximity` with a GPS observation.
4. Solve: `POST /api/hunts/:id/checkpoints/:checkpointId/answer` with `{stage:'personal', answers}` then
   `{stage:'team', answer}`. The server checks answers against the pinned Hunt snapshot.
5. Ask for help or report an emergency: `POST /api/hunts/:id/participants/me/help`.
6. See the ranking: `GET /api/hunts/:id/leaderboard` (members and Hunt staff only, display names only).

Organizers (and platform Admins) see `GET /api/hunts/:id/monitor`, can confirm a participant's arrival
(`POST .../participants/:pid/checkpoints/:cid/check-in`) and resolve help requests.

## Platform Settings

Admins change the global values below in **Admin → Platform Settings** (`GET/PUT /api/admin/settings`, migration 041).
Saved values override the environment variables, which override the defaults. Every change is written to the
Audit Log with old and new values. Settings: GPS reading age, accuracy and inaccuracy rule; default detection
radius for new Template saves; wrong-answer penalty on/off and default points for unscored content; Organizer
check-in on/off; answer attempts per minute; emergency number and participant safety notice; guest session length.

## Audit Log

`GET /api/admin/audit` lists privileged actions newest first: user provisioning and edits, role changes,
block/unblock, password replacement and removal; application decisions; Template approval, change requests,
suspension and radius edits; locality and city decisions; Hunt lifecycle and radius changes; Organizer check-ins
and resolved help requests; custom request updates; own password changes; settings changes. Rows are append-only
(a database trigger blocks edits and deletes); only allowlisted request fields are stored, never passwords or tokens.

## Provisional decisions

| ID | Pilot default | Where |
| --- | --- | --- |
| D1 GPS | Observation ≤ 30 s old, reported accuracy ≤ 20 m, centre of the reading inside the pinned effective radius (default 25 m). Grant lasts until the checkpoint is completed. Adjustable in Platform Settings (`gps.*`); `contained` switches to `distance + accuracy ≤ radius`. | `domain/gameplay.ts` |
| D2/D5 Teams | **Solo pilot**: each participant plays the Personal stage and then the Team stage alone, using the authored shared contributions. No team formation, fragments or five-minute recovery. Solo Hunts can now be published; Team size other than four stays blocked. | `models/Gameplay.ts`, `domain/huntReadiness.ts` |
| D3 Scores | The Template's authored `scoring` block: starting score, wrong-attempt penalty, first-attempt bonus, Team-stage points, FinishPoint puzzle and mission completion. Content without a scoring block scores 100 per stage. Ranking: score, then earliest finish, then earliest join. | `domain/gameplay.ts` |
| D4 Assistance | No hints, solutions or skips (their penalties are ignored). Wrong answers return `correct:false` with no expected value. Rate limits: 30 answers/min, 60 arrivals/min and 10 help requests/min per user. | `routes/participantAccess.ts` |
| D6 Pause/fallback | Paused or finished Hunts reject arrivals and answers; progress is kept. Organizers may confirm arrival for the current eligible checkpoint; the grant records `policy_revision='organizer-check-in'` and `granted_by_user_id`. | `models/Gameplay.ts` |
| D8 Answers | Unicode NFC, outer trim, inner whitespace collapsed, case-insensitive unless the content sets `caseSensitive`. Multi-select answers (`A|B`) compare as sets. | `domain/gameplay.ts` |

Guests: `POST /api/auth/guest` now stores an optional display name (≤ 60 characters), and guest tokens last
the Platform Setting `sessions.guestSessionHours` (default 4 h) so a Hunt does not drop players after one hour. Guest recovery is
still unresolved.

## Data (migration 038)

`participant_checkpoint_progress`, `participant_challenge_attempts`, `participant_score_events`
(idempotent per `event_key`) and `hunt_help_requests`; `hunt_participants` gains `started_at`,
`finished_at`, `last_activity_at`. Snapshots are never rewritten.

## Not included

Email delivery (Independent Organizer codes are shown on screen only when a local machine sets
`INDEPENDENT_ORGANIZER_DEV_CODES=true`; deployed servers answer 503 until a provider is approved),
Team formation and fragments, recovery, hints, custom-exercise gameplay (publication stays blocked),
Passport/prize allocation, email delivery, push or real-time updates (screens poll every 10 s).
