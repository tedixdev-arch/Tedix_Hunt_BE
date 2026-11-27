# Custom exercise gameplay

Participants can now play Hunts whose template uses custom exercises: Creator-written ("Create your own") or
approved Library exercises, which are embedded in the same `checkpoints[].customExercises` slots. Hunts with such
templates can be published.

## Stages

Each checkpoint has up to two stages, played in order:

| Stage | Source |
| --- | --- |
| Personal | `customExercises.personal` when present, otherwise the predefined content (`answerKeys` / `correctAnswers`) |
| Team | `customExercises.team` when present, otherwise the predefined `teamAnswer` |

A checkpoint with only a Team stage starts at Team; one with only a Personal stage completes when it is solved. A
checkpoint with neither stays unplayable (422 `challenge_unsupported`). Pilot gameplay is Solo: one participant plays
both stages and sees every Team contribution.

## What participants receive

`GET /api/hunts/:id/participants/me/play` adds `current.personalExercise` or `current.teamExercise`:
`{ type, classification, title, instructions, interaction }`. The interaction is built from a per-mechanic allowlist,
so answers, hints and solutions are never sent (decision D4: no hint/solution release, generic feedback on wrong
answers). In addition:

- Lists whose authored order may be the answer are shuffled per participant and checkpoint, deterministically, and
  never left in the authored order: tap-pair/match-columns right side, drag-drop items, sequence elements,
  build-problem pieces, scrambled-word and shared-final-key contributions.
- memory-card sends only `revealDelayMs`; the card face is the recall answer and is revealed after solving.
- For a custom Personal stage, `current.story` keeps only the checkpoint narrative (story fields, location); the
  predefined prompt it replaces is not sent.

## Answering

`POST /api/hunts/:id/checkpoints/:checkpointId/answer` with `{ stage, response }`. The response has the same shape as
the exercise's `answer`, without authoring flags such as `caseSensitive`:

| Mechanic | Response |
| --- | --- |
| tap-pair, match-columns | `{ pairs: [{ leftId, rightId }] }` (complete, any order) |
| single-choice, distributed-information | `{ optionId }` |
| true-false | `{ value: boolean }` |
| memory-card, hypothesis, clue-synthesis | `{ value: string }` |
| number-line | `{ value: number }` (within the authored tolerance) |
| multiple-choice | `{ optionIds: [] }` (exact set) |
| filter-noise | `{ trustedSignalIds: [] }` (exact set) |
| drag-drop | `{ assignments: [{ itemId, targetId }] }` (complete, any order) |
| fill-blank | `{ values: [{ blankId, value }] }` (every blank) |
| sequence | `{ order: [] }` |
| build-problem | `{ construction: [] }` |
| find-mistake | `{ stepId, explanationId }` |
| number-pattern | `{ value: number }` |
| shape-pattern | `{ shapeId }` |
| rule-discovery | `{ ruleId, predictedOutput: number }` |
| scrambled-word | `{ word }` (whitespace ignored) |
| assemble-machine | `{ frequencyId }` |
| shared-final-key | `{ code, order? }` (exact digits; `order`, when sent, must be the authored order) |

Text answers use the existing normalization (NFC, trimmed, collapsed whitespace, case-insensitive unless the
exercise is case-sensitive). A body shaped for the other source (`answers`/`answer` for a custom stage or `response`
for predefined content) is 400 `invalid_input`. Correct answers return `reveal`: `successText` (the authored correct
feedback) and, for memory-card, `recallCard`; Team reveals use `storySuccess` and never return the answer.

## Scoring

Custom stages use the same score events as predefined ones (`personal_solved`, first-attempt bonus, `team_solved`,
`finish_puzzle`, mission completion). Creator Studio saves `scoring: { model: "platform" }`; that now means the
Platform Settings defaults (`scoring.defaultPersonalPoints`, `scoring.defaultTeamPoints`) instead of an authored
table with zero points. Authored scoring tables are unchanged.

## Publishing

The former readiness rule "Custom exercise gameplay is not yet supported" is removed. Readiness now fails only when the
snapshot's custom exercises no longer validate against the exercise schemas.
