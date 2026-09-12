# Step 7.1: PostgreSQL backend foundation

## Local ChatGPT planning → Codex implementation

The owner authorized step 7.1 from the FE repository's
`docs/TedixHunt_Prototype_Architecture_Implementation_Plan.md`.
Backend baseline: `6f801f5`; implementation branch: `feat/postgresql-foundation`.

### Scoped implementation task

Implement PostgreSQL configuration from environment variables, pooled access using
`pg`, and versioned migrations using `node-pg-migrate`. Add a baseline migration
that initializes migration tracking only; do not create User or Hunt tables.
Add database readiness checks while preserving the existing liveness contract.
Require PostgreSQL connectivity before listening and close database connections on
shutdown. Isolate the legacy Mongo path, replace the hard-coded URI with
`MONGODB_URI`, and prevent disconnected legacy routes from buffering operations.
Keep existing configured Mongo-backed product route logic unchanged.
Provide setup/deployment instructions and meaningful configuration, readiness,
and real PostgreSQL migration checks.

Implement only the scope described. Do not redesign unrelated modules, introduce
speculative abstractions, or migrate additional prototype functionality unless
explicitly requested.

### Acceptance criteria

- Explicit PostgreSQL URL required; bounded pool, connection and query waits.
- No credentials in connection logs or readiness responses.
- Versioned migration command works on an empty database and is repeatable.
- Rollback and reapplication work; failed migrations are transactional.
- Readiness returns 200 when connected and 503 when unavailable.
- Existing liveness endpoints and configured legacy route logic are preserved.
- Build and automated tests pass; actual diff reviewed before PR preparation.

## Review and owner handoff

Implementation and review are separate passes in this local Codex task; this is
not an independent second-agent review. Review the actual diff against the scope
and acceptance criteria, resolve findings, then prepare one backend PR.
The owner merges and validates deployment using README instructions. Step 7.2
must wait for that validation.

### Local review results

- Reviewed configuration, readiness, startup/shutdown, migration runner and legacy
  Mongo isolation against the step scope; no product models or route logic migrated.
- Removed tracked stale build output and restricted test discovery to source tests.
- Build passes; 26 local tests pass. Five database integration tests await CI
  because the local Docker engine was unavailable.
- Dependency audit reports six findings (three high, three moderate). All six
  affected package versions are unchanged from the baseline; broader dependency
  remediation is outside this step.
- Deployment must supply PostgreSQL and the legacy Mongo URI; rotate the exposed
  historical Mongo credential. No production databases were contacted or changed.
