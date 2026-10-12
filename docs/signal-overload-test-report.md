# Signal Overload v1 — test report

Validated on 2026-10-12 against current `main`
`c34a66e5eb9ee16de6f5e52b3780688b8f934183`.

| Check | Actual result |
|---|---|
| `npm test -- src/domain/templates src/routes/creatorTemplates.test.ts` | 5 files, 124 tests passed. |
| `npm test` | 41 files passed, 2 skipped; 770 tests passed, 33 skipped; zero failures. |
| `npm run typecheck` | Passed. |
| `npm run build` | Passed. |
| `git diff --check` | Passed. |

The initial sandbox run could not bind Supertest's local HTTP ports (`EPERM`).
The focused and full suites then passed with the authorized local-port sandbox
escalation. Typecheck initially caught a readonly mutation in a new isolation
test; it was fixed before the successful checks above.

New definition tests cover stable unique identity, six normal checkpoints and
one unnumbered terminal, reversed landmark order, unchanged puzzle/stage order,
answers/hints/solutions/scoring, four contributions, chronological destinations,
removed obsolete fictional landmarks, disabled navigation, empty saved GPS,
research source/uncertainty preservation, independent snapshots, canonical
checksum preservation and existing version/submission validation.

The complete existing starter HTTP contract is parameterized over both old and
new endpoints. It covers Creator ownership, independent generated keys,
authentication/roles/guest and inactive accounts, rejected client overrides,
ordinary draft status, absent GPS, and conflicts that do not overwrite prior
Creator or platform keys. No version-update or submission call is made by
starter creation. Existing catalog, Hunt, model persistence and lifecycle tests
also pass in the full suite. No Hunt code, canonical content/snapshots, database
schema, FE or catalog seed changed.

Limitations: 24 migration tests and 9 PostgreSQL integration tests are skipped by
the existing suite because `TEST_DATABASE_URL` is not configured. HTTP/model
unit coverage runs, but real PostgreSQL integration was not executed here. No
physical route survey, field GPS capture, FE/mobile playtest, approval,
publication, merge or deployment was performed. Narrative continuity was
reviewed explicitly in `signal-overload-cluj-napoca.md`; automated assertions
cover structure/destinations rather than judging prose quality.
