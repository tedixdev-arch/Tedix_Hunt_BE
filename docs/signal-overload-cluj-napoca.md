# Signal Overload - Cluj Napoca — Creator review

Source identity: `signal-overload-cluj-napoca`, version `1`, theme `Signal Overload`.
This definition is a draft starter, not an approved platform catalog entry. The
canonical Signal v1, its checksum, existing starters, Hunts and saved versions
are unchanged. No migration or seed registers or publishes this definition.

The communication network, relays and transmitter exist only in the story and
app. No historical building or monument is represented as containing equipment.
The mission progresses through discovery, investigation, diagnosis, repair,
decryption, localization and resolution. Starting score remains 500; all
individual penalties/bonuses, team rewards, final puzzle reward (250) and
completion reward (100) match Signal v1.

| Stop | Landmark | Story opening | Puzzle | Team revelation | Next destination |
|---|---|---|---|---|---|
| CP1 ACCESS | Tailors' Tower — exterior | Overload has locked the app's diagnostic session. | Digit product: 72; all four letter shares form UNLOCKED. | Access reveals a corrupted trace. | Reformed Church — exterior |
| CP2 TRACE | Reformed Church — exterior | The trace contains broken algebra and a hidden receiver ID. | First error: step-3; four fictional grid facts locate receiver R at WEST. | Receiver R is identified; its message remains unread. | Saint George statue |
| CP3 IDENTIFY | Saint George statue | Four numbered receiver packets must be joined. | Square value: 4; all four packets decode SIGNAL. | The SIGNAL channel has a missing relay link. | Colegiul Academic — exterior |
| CP4 REPAIR | Colegiul Academic — exterior | A dismantled relay model represents the broken link. | Blocks 2,3,4 make 24; all four operations yield restart frequency 30. | Repair delivers an encrypted payload. | Babeș-Bolyai University — main building exterior |
| CP5 DECODE | UBB main building — exterior | The payload protects a clue behind a radial lock. | Missing value: 15; four riddle fragments identify CIPHER. | Decoding exposes a noisy transmitter locator. | Piarist Church — exterior |
| CP6 LOCATE | Piarist Church — exterior | Locator packets include conflicting or repeated grid labels. | Prime frequency: 29; compare all four packets and select LIAM\|ZARA. | The final transmitter record identifies the monument; the shared lock remains closed. | Matthias Corvinus monument — Piața Unirii |
| FinishPoint RESTORE | Matthias Corvinus monument — Piața Unirii | Six links reach a transmitter that still needs the team key. | Next prime: 13; all four digits form 2397. | Links synchronize, overload clears and “We can hear you” confirms communication. | Mission complete |

Each scene uses the existing mobile story fields: `storyProblem` opens the
situation, `storyObjective` names the immediate task, `storyPlan` explains the
puzzle's purpose, and `storyRisk` states the stakes. Existing puzzle fields,
personal contributions and team instructions carry the challenges. New
`teamRevelation` and `nextDestination` fields record the discovery and next
landmark; the latter is a narrative destination, not walking navigation.
`storySuccess` follows the team challenge. Individual `successText` never
completes the overall mission.

## Narrative continuity checklist

The following review explicitly checks discovery, cause of transition, logical
sequence, information timing and whether resolution remains at FinishPoint.

| Transition | Just discovered | Why the next scene follows | Logical / no premature information / mission unresolved |
|---|---|---|---|
| ACCESS → TRACE | The diagnostic fault log contains a corrupted trace tagged to the church. | Church scene examines that trace. | Yes. Receiver and failure cause are still unknown; access is not restoration. |
| TRACE → IDENTIFY | The four grid facts identify receiver R; its record is tagged to the statue. | Statue scene opens R's numbered message packets. | Yes. No message meaning is assumed before decoding; network remains offline. |
| IDENTIFY → REPAIR | SIGNAL labels the damaged channel; its receiver record reports a missing link tagged to Academic. | Academic scene rebuilds that identified link. | Yes. SIGNAL alone is not claimed to encode a place; the record supplies the destination. |
| REPAIR → DECODE | Restart frequency 30 restores a link and delivers a payload tagged to UBB. | UBB scene opens that encrypted payload. | Yes. Local repair is not full recovery; neither locator nor transmitter destination has been revealed. |
| DECODE → LOCATE | CIPHER identifies the decoder; the decoded record exposes a locator tagged to Piarist. | Piarist scene filters that locator's packets. | Yes. The final destination is still hidden; decryption does not resolve the mission. |
| LOCATE → RESTORE | Filtered packets identify the monument transmitter record and its shared lock. | Monument scene supplies the final prime and four-digit key. | Yes. Finding the destination does not open the lock or restore communication. |
| RESTORE → completion | All four digits open the shared lock and the six links synchronize. | A returning message concludes the mission. | Yes. Overall restoration occurs only here, after the final team challenge. |

- [x] Briefing starts at the tower and names only the mission, not future solutions.
- [x] ACCESS → TRACE → IDENTIFY → REPAIR → DECODE → LOCATE → RESTORE stays chronological.
- [x] Every discovery enables the next task; no scene assumes an unrevealed packet.
- [x] Old fictional landmark names are absent from the new active story.
- [x] WEST/NORTH/SOUTH/EAST are explicitly fictional grid labels; no compass or distance is supplied as walking guidance.
- [x] All four contributions remain necessary where the original mechanics require them.
- [x] FinishPoint contains the only overall mission resolution and retains its special scoring.

## Creator API contract for later FE integration

`POST /api/creator/templates/starters/signal-overload-cluj-napoca`
requires authenticated Creator capability and accepts an omitted body, `{}`, or
`{"key":"my-overload-review"}` only. Key normalization and the 100-character
limit match the existing starter. Omitting the key generates
`signal-overload-cluj-napoca-<uuid>`; `starterSource` retains the stable source
identity/version/checkpoint checksum. A supplied key that already exists returns
409 `template_key_conflict`, without replacing or versioning any prior draft.
The stable source key is not automatically reserved or persisted.

201 returns `{ key, version: 1, status: "draft", origin: "creator", content }`.
400 rejects invalid input/overrides, 401 requires a valid active identity, 403
requires Creator capability (not a guest). Server-side copying prevents client
ownership/content/status overrides. The owner comes from authentication.
The original `/starters/signal-cluj-napoca` endpoint remains available unchanged.
Both endpoints are documented in OpenAPI.

Use the ordinary Creator list/read/version endpoints to edit the draft. There
are six numbered normal entries and one unnumbered terminal entry, empty
`configuration.checkpointPositions`, no geographic `finishPoint`, and
`navigationMode: "none"` throughout. Existing submission validation rejects the
incomplete geography. After Creator field verification and geography authoring,
the existing submit/Admin review workflow applies; nothing auto-submits,
approves, publishes, or creates a Hunt.

## Remaining review and field dependencies

Creator review may refine tone, age suitability and pacing. Rewritten grid clues
keep the original mathematical and team answers; the FE must render these
editable strings and must not interpret diagnostic WEST as navigation. Rendering
of the additive narrative fields requires later FE integration (outside this PR).

All source URLs, landmark identities, reference pins, uncertainty and physical
verification status are retained. Original positional notes are attributed by
`originalProposalPosition`; old walking evidence is archived under
`walkingAssessment.originalSequenceAssessment`. Its checkpoint numbers and
approaches describe the original proposal, never the new walking route. New
walking legs supply no directions or distances.

Creators must survey the reversed route, choose public exterior gathering
boundaries, record legal crossings and accessible alternatives, check current
access/events/construction, and author all checkpoint and FinishPoint GPS/radii
separately. Especially verify separation between CP2 Reformed Church and CP3
Saint George statue. Research `candidateGps` remains landmark-reference-only;
no pin becomes saved gameplay geography or GPS confirmation. No new Mapbox or
Directions integration is included.
