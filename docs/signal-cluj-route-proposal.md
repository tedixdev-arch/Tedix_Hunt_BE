# Signal Cluj route proposal

New starter drafts include a desk-researched proposal at
`content.routeResearch.proposal`. Research date: 10 October 2026. All seven
physical verification statuses are pending. This is informational metadata,
not a verified gathering route or physical safety certification.

The structured source registry, candidate addresses, exterior arrival descriptions,
confidence, unresolved issues and six walking legs are in
`src/domain/templates/signalClujRouteProposal.ts`. Each source records the claim
it supports. VisitCluj is the municipality's official tourism site; UBB establishes
the main building address; municipal street-project notices supply geographic
corridor evidence. OpenStreetMap was attempted but its text-only response did not
expose geometry. The Google embedded maps returned 403; their URLs expose two
officially linked landmark pins, not surveyed arrival coordinates.

| Order | Gameplay mapping | Landmark address |
| --- | --- | --- |
| 1 | Normal checkpoint 1 | Matthias Corvinus monument, Piața Unirii |
| 2 | Normal checkpoint 2 | Piarist Church, Universității 5 |
| 3 | Normal checkpoint 3 | UBB main building, Mihail Kogălniceanu 1 |
| 4 | Normal checkpoint 4 | Colegiul Academic, Emmanuel de Martonne 1 |
| 5 | Normal checkpoint 5 | Saint George statue, Mihail Kogălniceanu 23 |
| 6 | Normal checkpoint 6 | Reformed Church, Mihail Kogălniceanu 21 |
| 7 | Terminal FinishPoint | Tailors' Tower, Baba Novac 2 |

The sequence is plausible along the municipal Universității–Kogălniceanu corridor,
with an Academic frontage stop at Emmanuel de Martonne. It is an inference from
addresses and the street project, not a routed or measured pedestrian survey.
No total walking distance or duration is claimed.

Unirii's southern traffic edge needs a designated crossing toward Universității.
Exact crossings, signals, refuge islands and curb ramps are unresolved. The
statue stands by the Reformed Church entrance: checkpoints 5 and 6 may be too
close for distinct gathering areas or GPS radii. Preserve the six gameplay entries
while physically testing boundaries and overlap; do not invent spacing.
At the tower, first investigate a public arrival area on the Kogălniceanu approach
side rather than crossing Baba Novac or the larger junction merely to reach a pin.
The precise approach, any necessary crossing and accessible alternative are pending.

All proposed stops are outdoors. No church, university, auditorium, courtyard or
tower interior is required, and the proposal imposes no paid entry or entrance
stairs. This does not establish unrestricted group access or step-free travel.
Verify paving, gradients, bollards, widths, curb ramps, event barriers, worship,
deliveries, shared-space bicycles/vehicles and group capacity. Historical 2023
construction notices identify affected streets but establish neither active works
nor clear access in 2026. Check current notices and walk the full route before use.

## Contract and lifecycle

The smallest compatible extension is the nested `routeResearch.proposal` object
inside existing JSON content. No schema migration, validator change or new
geographic subsystem is needed: ordinary owner-scoped GET/version editing
preserves informational JSON. Existing research, physical-verification and
walking-navigation statuses remain pending. The proposal schema version is 1;
it is separate from the Template's immutable version number.

`candidateGps` is null without supported coordinates. Two values are explicitly
`landmark-reference-only`, with `arrivalLocation: false` and a source ID. Neither
building-centre pin defines a gathering boundary. There is no promotion code:
`configuration.checkpointPositions` stays empty and `configuration.finishPoint`
stays absent. Creators separately author six complete positions and a FinishPoint
in a new draft version after field work. Existing structural submission validation
and Admin review remain unchanged and do not certify physical truth.

Only subsequently created starter drafts receive this proposal. No migration or
database write updates canonical Signal v1, approved content, existing Creator
drafts or Hunt snapshots. Gameplay mapping, story, Personal/Team Challenges,
answers, hints and scoring remain unchanged. Fictional navigation remains under
`fictionalNavigation` with `scope: puzzle-only`; real route suggestions live only
in proposal metadata, with active navigation still disabled.

## Validation

Base: current `main`, `949a1b52f75f34bfe85716ffdb50c7d12195e8fc`.
The workspace proxy prevented Git fetch. The six files changed since the local
checkout were fetched at that exact commit through the GitHub connector; the
reconstructed base tree matched `13993c9f81a83eb1fa2206f18f0f6844a1ea8a04`
exactly. The PR commit is parented directly to current main.

- Focused domain tests: 9 passed, including whole-object gameplay reconstruction,
  canonical digest, candidate metadata and no coordinate promotion.
- Full suite with disposable local PostgreSQL 17: 743 passed across 41 files,
  no skipped tests. Includes existing Creator API and database lifecycle tests
  that assert unchanged approved content and Hunt snapshots. Any approval in
  these tests concerns synthetic local fixtures only.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.

An initial sandboxed run could not bind Supertest server ports (`listen EPERM`).
The complete suite passed with local-server permissions. The disposable database
was removed after validation. No production database, Template approval,
publishing, deployment or merge was performed. Physical verification, precise
crossings, accessibility and gathering-area GPS remain unresolved as recorded above.
