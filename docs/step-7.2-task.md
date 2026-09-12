# Step 7.2 — Core User schema

## Scoped implementation task

Starting from the merged step 7.1, add the minimum PostgreSQL identity schema
with a stable UUID, unique case-insensitive email, optional password hash and
display name, and creation/update timestamps. Add a versioned reversible migration
and real PostgreSQL integration tests. Do not migrate legacy Mongo users or change
authentication routes; PostgreSQL authentication is step 7.3.

Implement only the scope described. Do not redesign unrelated modules, introduce
speculative abstractions, or migrate additional prototype functionality unless
explicitly requested.

## Schema decisions and acceptance criteria

- `public.users.id` is a generated UUID primary key; future role and Hunt membership
  tables can reference it. Users are not restricted to one role. Role assignments,
  capabilities and contextual Supervisor permissions belong to steps 7.6–7.8.
- Email is required, case-insensitively unique, at most 254 characters, with basic
  shape/whitespace checks. Application-level email validation and verification
  belong to authentication. Case folding is the explicit identity policy.
- `password_hash` may be null for an identity without a local password. Step 7.3
  must reject password login for such users, hash passwords before storing them,
  and never return hashes in API responses. An empty hash is rejected.
- Optional `display_name` is trimmed, nonempty when supplied, and at most 120 characters.
- Timestamps use `timestamptz`. The application must explicitly set `updated_at`
  on future updates; this migration does not introduce a database trigger.
- Migration replay preserves records; rollback drops the users table and its data.
  Rollback is for disposable testing only unless an operator has approved data loss
  and verified backups. Use a forward corrective migration on populated deployments.
- Existing Mongo-backed routes remain unchanged. No live server/database changes.

## Validation and handoff

Run the build and source tests, then verify PostgreSQL 17 CI for migration
apply/repeat/rollback/reapply, UUID/timestamp defaults, identity constraints, and
data preservation. Review the actual diff before preparing one BE PR.

The owner authorized development to proceed while Hetzner access is pending.
Deployment validation for 7.1 and 7.2 remains outstanding: inspect PostgreSQL version,
existing schemas and migration history, back up relevant data, and apply reviewed
migrations to the dedicated prototype database. A pre-existing `public.users` table
must be reconciled before this migration; it intentionally fails rather than
silently adopting or overwriting an unknown table. PostgreSQL 17 is the tested target.
