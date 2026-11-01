# G4c-2 development database binding

Prepared for ChatGPT re-review only. Do not dispatch until review is complete.
The manual workflow uses only the existing development SSH host/account/key,
shares `dev-deploy` concurrency, and never deploys, imports, migrates, restarts,
changes database permissions or escalates privileges. No production inputs exist.

## Independent identity evidence

The administrator designated pgAdmin connection `tedixhunt_dev`. The owner verified
`tedix_hunt`, `tedix_app`, migrations 001–034, zero cities and no import history.
Database/user names and a connectivity probe do not establish server identity.
The supplied evidence does not contain a numeric server identity. Independently
obtained values from that designated connection must be recorded as repository
variables `DEV_PG_SYSTEM_IDENTIFIER`, `DEV_PG_SERVER_ADDR`, `DEV_PG_SERVER_PORT`.
The administrator can obtain them with read-only SQL:

```sql
SELECT system_identifier::text FROM pg_catalog.pg_control_system();
SELECT inet_server_addr()::text, inet_server_port();
```

Never populate these from the backend under test or copy a connection string.
A Unix socket/null address or a proxy/replica endpoint requires independent review;
this verifier supports a directly comparable TCP endpoint. Values are withheld
from all diagnostics and compared privately without weakening the comparison.

The probe first confirms current/session user `tedix_app`, then evaluates:

```sql
SELECT has_function_privilege(
  current_user, 'pg_catalog.pg_control_system()', 'EXECUTE'
);
```

Only a true result permits the identity query. False or SQLSTATE 42501 reports
`BLOCKED: missing permission: EXECUTE on function pg_catalog.pg_control_system()`.
There is no fallback to names alone, alternate role, grant, sudo or escalation.
The query is valid on PostgreSQL 17; EXECUTE is restricted by default and must
not be assumed for `tedix_app`. Existing development role permissions have **not**
been confirmed live: this correction does not execute the workflow or contact the
development database. The actual role ACL is checked on an eventual approved run;
a grant is never proposed or applied automatically. Synthetic tests cover both
false ACL and permission-denied execution, including cleanup.

## Versioned configuration verification

Contract version 1 in `verify-dev-db.cjs` records SHA-256 fingerprints of reviewed
server/configuration/pool artifacts, importer source, lockfile and relevant pg,
connection-string and dotenv implementation files. The artifacts were produced
from main `1cc79aaebfffa3f477dd967ed2727f7675c9c212` with TypeScript 5.9.3.
This replaces substring/formatting checks on compiled JavaScript with an explicit
version-aware allowlist. A different artifact is BLOCKED, not heuristically accepted.
A new build/toolchain requires reviewing the configuration path, updating the
contract and its tests, and reviewing the PR before use. The verifier never
imports backend, importer or migration entrypoints. Build hashes are tested against
the checkout. Trusted deployment files and normal filesystem metadata are assumed;
this does not attest against a malicious server administrator rewriting history.

The supported reviewed configuration binds backend and importer to launch
DATABASE_URL using the same pg implementation. The probe requires a direct Node
MainPID in the deployment directory and a complete launch URL with host, user,
password and database. Only the service's launch PG variables supply pg fallbacks;
the SSH account's defaults are removed. Configuration artifacts modified since
process start, custom Node/dotenv loaders and external credentials/TLS files block
verification. Existing credential/TLS security behavior is never relaxed.

Permission denial while reading `/proc/<MainPID>/environ` is explicitly BLOCKED,
with that exact missing read permission. No privilege escalation is attempted.
Linux exposes the launch environment, not later dotenv mutations. A missing launch
DATABASE_URL blocks; the probe never substitutes current `.env` contents. Because
historical dotenv pg fallback values cannot be recovered, **the presence of a
server .env file also blocks**, even if DATABASE_URL is in the launch environment.
Unreadable .env metadata blocks too. This conservative supported scope is deliberate;
a service outside it requires a separately reviewed runtime configuration contract,
not environment changes by this workflow. No live effective-configuration PASS is
claimed. Process identity is rechecked before final success.

## Read-only operation and safe reporting

Queries run in one bounded repeatable-read READ ONLY transaction, followed by
ROLLBACK. Checks cover database/current/session roles, independent cluster and
endpoint identity, exact migration IDs 032–034, catalog/reference tables, zero
cities and zero import records. Migrations 001–031 are not reverified.
All exceptions and mismatches reach `finally`: rollback is attempted after any
BEGIN attempt, and close is attempted even if connect or rollback fails. Async
connection errors set failure state instead of terminating the process. Final PASS
is emitted only after successful rollback and close. Cleanup errors report BLOCKED.

Remote stdout uses only `DEV_DB_V1 <fixed-code>` records. The local renderer rejects
unknown codes, arbitrary PASS/BLOCKED/FAIL text, banners, annotations, control bytes,
oversized output, invalid ordering and exit-status inconsistencies. It maps accepted
codes to locally defined messages; no remote-provided free text reaches logs or
Markdown. Raw stdout and stderr are not printed, and raw stdout is removed on exit.
The summary contains only the local report. FAIL indicates an observed mismatch;
BLOCKED indicates insufficient evidence/permission/connectivity or failed cleanup.
Both cause a non-success job. SSH host-key discovery retains the existing deployment's
ssh-keyscan trust-on-first-use limitation.

## Local validation

Run `npm run build`, `node scripts/ci/verify-dev-db.test.cjs`, and `npm test`.
The dedicated tests use synthetic process/database fixtures only. They cover the
supported artifact contract, inaccessible process environment, unknown builds,
configuration ambiguity, restricted identity access, mismatches and rollback/close
on failure, plus protocol injection and exit-status filtering. Workflow YAML and
embedded Bash syntax are checked separately. No workflow dispatch or live SSH/SQL
is part of these tests.
