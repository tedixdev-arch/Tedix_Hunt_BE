# Template-owned custom exercises

Backend persistence contract, 31 October 2026 (Europe/Bucharest). Scope: BE only. No shared library, new exercise endpoint, FE changes, scoring/reward changes, automatic data migration, approval workflow or execution-plan task IDs.

## Architecture and inspected sources

The base is BE `bf0023c` (main, merged #92). Preparation covered migrations 016–028, the HuntTemplate and PublishedUniversal repositories, Universal/Local/Legacy authoring, submission and Admin decisions, OrganizerLocalTemplate selection, Hunt snapshot creation/read/publication, checkpoint vocabulary, both Signal starters, geography projections, public access-code resolution, Hunt contexts, authentication, OpenAPI and existing integration tests. FE integration reference: merged [FE #136](https://github.com/tedixdev-arch/Tedix_Hunt_FE/pull/136), `docs/evidence/Creator_Challenge_Library.md`, especially “Exact FE data requirements for future backend integration” and its mechanic matrix. That document supplies logical requirements; it did not establish a BE wire contract.

Existing `hunt_template_versions.content` JSONB already stores complete snapshots. Custom instances are embedded in checkpoint slots inside that payload, so no extra tables or mutable references are needed. Migration 029 adds only ownership/immutability guards; it never rewrites existing rows. `schema.sql` includes the same guards. All existing no-custom payloads keep their fields and values.

## Wire representation

Use the existing endpoints:

- `POST /api/creator/templates`: `{key, content, category?, localityId?}`; content version 1.
- `POST /api/creator/templates/{key}/versions`: `{content, localityId?}`; complete content with the next version, as before.
- Owner list/detail GET, submit response and authorized Admin review return the complete saved content.
- Existing `POST /api/creator/templates/from-universal/{sourceKey}` makes an independent Local copy.

Extend each existing checkpoint with optional `customExercises`. It is a closed object containing `personal`, `team`, or both. Each slot contains exactly one complete instance. Assignment is containment, never an external exercise ID. All existing `kind`, `teamKind`, answers, hints, navigation and unknown Legacy fields are preserved. The custom instance selects custom content for its classification; it does not modify the saved predefined content. Removing the slot restores predefined-only configuration. Omit `customExercises` when neither slot is custom; an empty object or null is invalid.

Normal entries use unique `checkpoint` integers in 1…normalCheckpointCount (or 1…20 if the old non-geographic contract omits count). `checkpointNumber`, if present, must agree. FinishPoint is the one existing unnumbered `role: "terminal"` entry. It never becomes another normal checkpoint or position. Custom content opts into unambiguous normal numbering even in an otherwise Legacy-shaped payload. Existing challenge fields remain optional: this feature does not force either classification onto every checkpoint. Submission still applies the original geography/category rules.

Example new instance inside a normal checkpoint (the rest of Template content remains required):

```json
{
  "checkpoint": 1,
  "role": "normal",
  "kind": "hidden-rule",
  "customExercises": {
    "personal": {
      "type": "single-choice",
      "classification": "personal",
      "schemaVersion": 1,
      "title": "Choose the result",
      "instructions": "What is 2 + 2?",
      "interaction": {
        "options": [{"id":"three","text":"3"},{"id":"four","text":"4"}]
      },
      "answer": {"optionId":"four"},
      "hints": ["Count two more."],
      "solution": "Two plus two is four.",
      "feedback": {"correct":"Correct!","incorrect":"Try again."}
    }
  }
}
```

The server adds authoritative fields to each saved instance:

```json
{
  "id": "22a8945d-01fb-49ac-b18b-34c1f779be85",
  "owner": {"templateKey":"my-hunt-template","version":1}
}
```

`id` is a server UUIDv4. The globally unique Template key plus version identifies the owning snapshot; no client-supplied user ownership is trusted. On initial creation/new slots omit **both** `id` and `owner`. On version save the client may echo both from the **latest saved source version at the same checkpoint and classification**. The backend verifies that reference, copies all data, and allocates a fresh UUID and destination owner for every instance in the new immutable version. Return values are authoritative; replace local IDs/owners after saving. A supplied foreign, older-source, moved-slot, forged or duplicated ID is rejected. To create an independent new instance or move content to another slot, send its data without ID/owner. There is no cross-template reference or reuse API. Trusted Universal copying strips source identities and allocates destination-owned identities transactionally. Identity is stable within a persisted version, not across new versions.

## Exact schema and validation

`GET /api/docs.json` exposes `CreatorTemplateContent.checkpoints[].customExercises`, `CheckpointCustomExercises`, `CustomPersonalExercise`, `CustomTeamExercise` and `CustomExercise`. The type-specific `oneOf` variants come from the same declarative schemas as the server validator in `src/domain/customExerciseSchemas.ts`. Each variant is closed at every custom object level. Required common fields: `type`, `classification`, `schemaVersion`, `title`, `instructions`, `interaction`, `answer`, `hints`, `solution`, `feedback`. ID/owner are paired optional input fields and always present on saved output. Unsupported schema versions, mechanics, classifications and fields are rejected, never stripped.

Notation below: `items` means ordered `{id,text}[]`; IDs are 1–64 ASCII letters/digits/underscore/hyphen, starting with a letter/digit and unique **within each named collection**. Reference values are these IDs, not option labels. Arrays retain their authored order. Different collections may use the same item ID. Where an inventory piece must occur twice, create two distinct inventory IDs.

| Personal type ID | Required interaction fields | Required answer fields / relational rules |
| --- | --- | --- |
| `tap-pair` | `left: items`, `right: items` | `pairs: {leftId,rightId}[]`; complete bijection of both sides |
| `single-choice` | `options: items` | `optionId`; must exist |
| `true-false` | `{}` | `value: boolean` |
| `memory-card` | `card: text`, `revealDelayMs: integer` (1000–60000) | `value: text`, `caseSensitive: boolean`; fixed recall/reveal behavior, not a Hunt timer |
| `number-line` | `min`, `max`, `step` | `target`, `tolerance`; min < max, positive step, integral endpoint/target ticks within 1e-7, target in range, tolerance 0…range, at most 1,000,000 ticks |
| `multiple-choice` | `options: items` | `optionIds: ID[]`; nonempty distinct subset |
| `match-columns` | `left: items`, `right: items` | complete `pairs: {leftId,rightId}[]` bijection |
| `drag-drop` | `items: items`, `targets: items` | `assignments: {itemId,targetId}[]`; each item once, valid targets; targets may repeat |
| `fill-blank` | `blanks: {id,prompt}[]` | `values: {blankId,value}[]`, `caseSensitive: boolean`; each blank once |
| `sequence` | `elements: items` | `order: ID[]`; complete permutation |
| `find-mistake` | ordered `steps: items`, `explanations: items` | `stepId`, `explanationId`; both valid; first incorrect step and explanation are authored answer data |
| `build-problem` | `pieces: items`, ordered `slots: items` | `construction: ID[]`; one distinct allowed inventory piece per slot, in slot order |
| `number-pattern` | `terms: {id,value?}[]`, `missingId` | numeric `value`; at least three terms, exactly one absent term value at missingId |
| `shape-pattern` | `terms: {id,shapeId?}[]`, `missingId`, `shapes: items` | `shapeId`; valid shape references, exactly one absent shape at missingId, at least three terms |
| `rule-discovery` | `examples: {input,output}[]`, `rules: items`, `predictionInput: number` | `ruleId`, `predictedOutput: number`; valid rule ID and distinct example inputs; rule labels are inert text, never evaluated |

| Team mechanic ID (unchanged) | Required interaction fields | Required answer fields / relational rules |
| --- | --- | --- |
| `scrambled-word` | `contributions: items` | `word`, `caseSensitive`; contributed letters reconstruct the answer (whitespace ignored, uppercase comparison unless case-sensitive) |
| `distributed-information` | `facts: items`, `options: items` | valid `optionId` |
| `hypothesis` | `packets: items`, `decoderKey: text` | `value: text`, `caseSensitive`; decoded answer is authored data |
| `assemble-machine` | `contributions: items`, `frequencies: {id,text,value}[]` | `frequencyId`; valid frequency choice; nonnegative, distinct finite frequencies; preserves frequency-choice mechanic |
| `clue-synthesis` | `clues: items`, `answerPattern: text` | `value: text`, `caseSensitive`; pattern is display text, not an executable regex |
| `filter-noise` | `signals: items` | `trustedSignalIds: ID[]`; nonempty distinct subset |
| `shared-final-key` | `contributions: {id,digits}[]`, `orderingInstructions: text` | `order: ID[]`, `code: digit string`; complete permutation and exact concatenation, retaining leading zeros |

All named fields above are required except the explicitly optional missing-pattern values and ID/owner pair. Numeric values are finite in −1e9…1e9 unless tighter bounds apply; number-line step is at least 0.000001, tolerance nonnegative. General collections allow 1–40 entries; options/left/right/items/targets/elements/steps/explanations/pieces/shapes/rules/frequencies and mapping-pairs/drag assignments/order permutations have minimum 2 as specified in OpenAPI. Team contributions/facts/packets/clues/signals allow 2–16 entries; final-key ordering allows 2–16 entries. Hints allow 0–10 strings. Pattern terms require at least three via relational validation. Example lists require 2–40. `construction` and fill blanks may have one entry.

Text: title 1–200, instructions and solution 1–4000, general item text/hint/feedback/card/key/instructions 1–2000, textual answers 1–500, reconstructed word 1–100, frequency labels 1–100, answer pattern 1–200 characters. Non-whitespace text is required. Markup tags and unsafe control characters are rejected. Strings are preserved exactly, including whitespace/newlines and Unicode; consumers must render them as text, never HTML. Digits are ASCII 0–9; contribution 1–16, complete code 2–256 characters. No expression, script, regex execution, engine configuration or eval is supported. Semantic truth of authored riddles/examples is an Admin content-review concern; validators enforce structure, membership and stated relations, not mathematical theorem proving.

The existing Express JSON request limit is 100 KiB for the complete request. Custom model validation also bounds complete content to 100 KiB, depth 12 and 12,000 values before recursive schema validation, and at most 20 normal entries plus FinishPoint. Errors return HTTP 400 `{error:"invalid_custom_exercises",details:[{path,message}]}` (at most 30 details). Existing errors for basic Template validity, permissions and lifecycle remain unchanged (400/401/403/404/409). Exceeding the HTTP body limit is handled by existing request middleware. No sanitization silently alters exercise content.

## Lifecycle, ownership and compatibility

Every save creates a new immutable version, including draft saves; there is no in-place exercise edit. Creator-owned locking queries govern authorization and serialize allocation. Submitted versions cannot be saved over. Submission pins exactly the latest saved version and verifies persisted custom ownership; review reads the pin. Approved classified Templates may create a fresh draft candidate, retaining old approval/publication; classified changes_requested candidates can also be revised. Unclassified Legacy approval remains non-revisable under the established rules. No new transition was introduced.

Migration 029 rejects updates to any custom-bearing version (including removing all custom fields), rejects introducing custom content through an UPDATE, freezes identity/key/ownership for Templates with custom-bearing versions, and verifies persisted instance UUIDs, classification, schema version and exact key/version ownership at insertion/update. Classified snapshot protections still apply. HTTP/model authoring performs the complete type-specific validation; the database guard is an ownership/immutability backstop, not a second gameplay schema engine. Existing unused draft deletion/cascade behavior is preserved. Old rows without custom exercises are neither changed nor newly frozen by this migration.

Both Signal starters remain generated by the original functions with the same 6 normal entries, terminal FinishPoint, puzzle data, route proposal, geography, scoring, navigation and reward behavior. No defaults or canonical exercise identifiers are replaced. Existing Universal/Local/Legacy no-custom clients round-trip unchanged.

## Answer data access and remaining gameplay limitation

| Path | Behavior |
| --- | --- |
| Creator owner reads and save/submit responses | Full custom content; other owners/platform keys remain indistinguishable 404 |
| Admin review | Full exact submitted artifact through existing Admin policy |
| Published Universal library | Existing Creator-authorized content/copy policy; copying allocates independent Local instances |
| Public/Organizer catalog and geography previews | Existing metadata/geography allowlists; no custom answer fields |
| Organizer Hunt selection | Complete exact saved artifact is captured, including custom answers, for authorized Hunt organizers |
| Hunt list/detail | Full custom snapshot only for a Hunt organizer; supervisor-only readers get `templateSnapshot:null`, including participants with a supervisor context |
| Public access-code resolution | Only Hunt ID/code/name/status |
| Participant Hunt contexts | Existing identity/status/context flags only |
| Checkpoint delivery and answer submission | No such backend endpoints currently exist; no custom gameplay is exposed |
| Hunt publication | Custom-bearing snapshots fail authoritative readiness with 422 `hunt_not_ready`; selecting into a draft remains supported |

Follow-up integration must implement authenticated checkpoint-specific projection, controlled hint/solution release, server-side answer submission checking for each mechanic, per-team contributions/stages, and resolution of version-owned custom slots before enabling gameplay. It must retain existing scoring, rewards and FinishPoint semantics. Do not remove the publish gate merely because FE preview works. This PR implements persistence, not end-to-end Creator/Participant functionality.

## FE integration instructions

Keep FE #136's experimental persistence gate until the deployed BE contract is verified and the FE adapter is implemented. Map session drafts to the data above, preserving all stages; use stable item IDs rather than answers by label. Convert single FE hint text to `hints:[text]` (or `[]` when absent) and map solution text losslessly. Use the exact 15 Personal IDs in the table and unchanged seven Team IDs; never put new Personal IDs into legacy `kind`. Serialize the chosen custom slot into its checkpoint; retain the unnumbered terminal entry and translate total count to normal count as before. New instances omit ID/owner; subsequent saves echo the latest response metadata at the same slot and set the complete Template's next version. Hydrate from the server response after every successful save and preserve all fields on reload. On errors retain the working draft. Show custom persistence and gameplay availability separately; a saved/reviewed custom Template cannot yet back a published Hunt.

## Verification

Verification on 31 October 2026 (Europe/Bucharest): Tests use real disposable PostgreSQL databases, run all numbered migrations from the pre-migration baseline, and remove the databases afterward. They do not use a production database or deploy application changes.

- `npm run typecheck`: passed.
- `npm run build`: passed.
- Full `TEST_DATABASE_URL=<disposable PostgreSQL> npm test`: 64 files, 1,464 tests passed, zero failures/skips.
- Final focused validation: 119 tests across custom validators/OpenAPI, real custom API/lifecycle and the migration suite passed. Includes all 22 mechanics, multiple/terminal slots, exact field retention, independent Universal and Local revisions, independent copies, authorization, ownership rejection, database identity/snapshot guards, starter/Legacy round-trips, exact Organizer snapshots, public/participant/supervisor answer protection and blocked publication.
- Compiled migration discovery against a fresh disposable database: all 29 applied, last `029_template_custom_exercises`; immediate repeat applied zero. Complete `src/db/schema.sql` bootstrapped separately; custom snapshot guard present in both.
- `git diff --check`: passed.
- No remaining environment blocker. Local socket/Docker access initially required the execution permission path; disposable PostgreSQL then ran successfully. Existing pg concurrent-query deprecation warnings appeared in older tests and did not fail the suite.
- An initial custom integration run passed 27/28; the remaining fixture lacked geography required by the existing Legacy submission contract. The fixture was corrected without loosening production validation; subsequent runs passed.

No merge, deployment, production database access or FE modification was performed. Stop for ChatGPT review of the Draft BE PR.
