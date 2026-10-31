# Task 5 contract-only validation

31 October 2026 (Europe/Bucharest). Base: GitHub main `4e6cb521ba6ac930d28cd513935d83367ee80f91`. Changes are documentation and an executable static contract checker only. No gameplay routes, migrations, score logic or publication eligibility are implemented.

| Check | Observed result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `TEST_DATABASE_URL=<disposable PostgreSQL 17> npm test` | **64 files, 1,464 tests passed; zero failed/skipped** |
| Compiled migration discovery on fresh disposable DB | All **29** applied, ending `029_template_custom_exercises`; immediate repeat applied **0** |
| Independent complete `src/db/schema.sql` bootstrap | Passed on another fresh disposable DB |
| Existing runtime Swagger generation | Passed; 70 paths; proposed challenge operations absent, as intended |
| `node docs/validate-participant-gameplay-contract.mjs` (after build) | Passed OpenAPI 3.0.3 syntax/reference validation, all 22 delivery/submission variants, eight examples and extra-field rejection checks |
| `git diff --check` | Passed |

The static checker uses existing dev dependencies (`@apidevtools/swagger-parser`, `ajv`, transitively installed by current lockfile) and compiled canonical schemas. It does not execute an HTTP endpoint, prove transaction safety, or validate membership/progression. It is a review aid, not a new gameplay test suite. The separate proposal is not merged into runtime `/api/docs.json`, so consumers cannot mistake proposed operations for deployed capabilities.

The full regression includes real PostgreSQL authoring, migrations, approval, publication blocking, custom ownership/immutable snapshots and answer-protection paths already present in BE #93; all 22 definitions are covered by existing authoring tests. Existing Signal/Legacy, auth, Hunt lifecycle and reward configuration tests passed. There is no backend gameplay, scoring/leaderboard or Passport execution test to pass on this base. All new gameplay security and mechanic execution acceptance cases remain **not implemented**, listed explicitly in the contract and its per-mechanic matrix. No live FE–BE, production multiplayer, GPS or production deployment test is claimed.

Infrastructure history: the first unprivileged run could not bind local HTTP sockets (`listen EPERM`); without `TEST_DATABASE_URL` it reported 16 failed/30 passed/18 skipped files and 566 failed/474 passed/424 skipped tests, with 561 unhandled socket errors. The approved execution permission path then allowed the actual Express suite and disposable PostgreSQL to run; the final complete run above supersedes that infrastructure failure. Existing pg concurrent-query deprecation warnings did not fail tests. The first standalone compiled-migration check rejected a missing JWT secret during import; it was rerun successfully with an ephemeral generated key, without changing application validation. No configured credentials were read or printed.

Direct Git fetch failed because the worker proxy was unreachable. The authenticated GitHub connector verified current main and supports Draft PR delivery; the stale local `origin/main` was not used as the base. Disposable test databases were dropped by the suites/checks, and the dedicated PostgreSQL container was removed after validation. No production database was used.

No runtime or database changes, no newly publishable mechanics, no FE modification, no merge or deployment. **Contract-only Draft PR; stop for ChatGPT PR review. Task 5 production execution remains incomplete.**
