# G4c-2 development database binding

Prepared for ChatGPT review only. Do not dispatch until review is complete.
This manual workflow uses the existing development SSH host/account/key and
`dev-deploy` concurrency. It never deploys, imports, migrates, restarts, modifies
database permissions, escalates privileges or targets production.
The owner reports all three `DEV_PG_*` repository variables are configured; this
correction neither reads nor replaces their values.

## Configuration behavior established from the repository

- `src/server.ts` loads `dotenv/config` before constructing the application.
- Reviewed dotenv 17 defaults read `.env` in the process working directory and
  fill missing process environment keys, without overriding launch values,
  including launch values that are empty. Custom dotenv options/Node loaders
  are outside the supported contract and remain BLOCKED.
- `src/config/environment.ts` captures `process.env.DATABASE_URL` at module load.
  `src/lib/postgres.ts` constructs its Pool from that captured value. pg also
  uses PG environment fallbacks for options not supplied by the URL.
- `src/scripts/importGeonames.ts` independently loads `dotenv/config` and uses
  `new Pool({connectionString:process.env.DATABASE_URL})`. It is never imported
  or executed by this verifier.
- `.github/workflows/backend.yml` runs development deployments in
  `/var/www/Tedix_Hunt_BE`, explicitly excludes `.env` from rsync, builds, then
  restarts `tedixhunt-api`. It does not define a systemd unit or prove that the
  unit supplies an EnvironmentFile. The installed unit, launch environment and
  its permissions have not been inspected live. A direct Node MainPID and the
  deployment working directory are checked on an eventual approved run.

Thus the preserved `.env` can be the real source of DATABASE_URL even when it
is absent from `/proc/<MainPID>/environ`. Linux exposes launch environment, not
later dotenv mutations. File existence or timestamps cannot establish the
historical values loaded by the running service. The old unconditional `.env`
block is removed; it is replaced with independent evidence of the live target.

## Supported read-only proof with preserved .env

1. Read launch environment privately and parse current `.env` with the reviewed
   dotenv parser. Launch keys take precedence exactly as they do by default in
   the service and importer. This is a **candidate for a future importer run**,
   never a substitute for the backend's historical effective environment. The
   importer scope is invocation from the deployment directory with those same
   captured launch values and preserved .env, not an arbitrary SSH shell's
   defaults. The workflow never launches it or transfers environment contents.
2. Before connecting, check the candidate's actual pg user/database and resolve
   its host against the independently configured development address/port.
   A different endpoint is rejected without opening a database connection. DNS
   and the existing development host's filesystem are trusted infrastructure.
   All resolved addresses must match; ambiguous/multi-address hosts may block.
3. Connect using the candidate, without running importer/application entrypoints.
   Open one bounded repeatable-read READ ONLY transaction. Verify current/session
   role `tedix_app`, database `tedix_hunt`, cluster system identifier and server
   address/port against the independent pgAdmin evidence.
4. Read socket inode links in `/proc/<MainPID>/fd`. Intersect these **owned**
   inodes with established TCP records in `/proc/<MainPID>/net/tcp` and `tcp6`.
   The network tables alone contain other processes and are insufficient.
5. Match the socket's remote endpoint to the verified PostgreSQL listener and
   its local address/port to an existing own-role `pg_stat_activity` session for
   `tedix_app` in `tedix_hunt`. The verifier's own PostgreSQL PID is excluded;
   its socket belongs to a different OS process. Require the same socket inode,
   endpoint tuple, PostgreSQL PID and backend start time across repeated reads.
   IPv4, IPv6 and IPv4-mapped IPv6 are compared as bytes using native proc word order.
6. Confirm migrations 032–034, public catalog/reference tables, zero cities and
   zero import records. Refresh PostgreSQL's statistics snapshot and repeat the
   socket/session match. Recheck MainPID/start time and ensure current `.env`
   bytes did not change during verification, without printing them or their hash.
7. Roll back and close before reporting final PASS.

This proves the **live backend connection's database/role/server binding** and
that the current importer candidate can connect to that same independently
identified target. It does not claim to recover the backend's historical password,
TLS options or exact environment bytes. A current `.env` edited after startup can
pass only if its target is independently corroborated by the existing backend
socket/session. A candidate connection by itself never establishes runtime binding.
No API request is made to induce a connection, and no account or application data
is read. Migrations 001–031 are not reverified.

## Independent cluster identity and permissions

The administrator-designated pgAdmin connection remains `tedixhunt_dev`.
`DEV_PG_SYSTEM_IDENTIFIER`, `DEV_PG_SERVER_ADDR` and `DEV_PG_SERVER_PORT` are the
owner-configured independent comparison values. Never populate them from the
backend under test or copy a connection string into diagnostics.
The administrator's independent read-only evidence queries are:

```sql
SELECT system_identifier::text FROM pg_catalog.pg_control_system();
SELECT inet_server_addr()::text, inet_server_port();
```

On the candidate connection the verifier first checks:

```sql
SELECT has_function_privilege(
  current_user, 'pg_catalog.pg_control_system()', 'EXECUTE'
);
```

False or SQLSTATE 42501 is BLOCKED with the missing EXECUTE permission. The probe
never grants it, changes role, uses sudo or weakens comparison to database/user
names. Existing `tedix_app` permissions and the configured independent values
have not been tested live. Own-role `pg_stat_activity` endpoint metadata normally
requires no pg_monitor grant; if restricted, verification blocks and names the
required read operation. SQL uses SELECT only plus transaction BEGIN/ROLLBACK;
`pg_stat_clear_snapshot()` clears the session's statistics cache, not database data.
All identity/session/address values are withheld from diagnostics.

## Limits and the smallest safe alternatives

The automatic check remains BLOCKED if the deployment account cannot read the
backend's launch environment, `.env`, fd links or network tables, if the pool
has no open connection, if a connection races closed, or if the installed unit
uses an unsupported launch. Unix sockets, NAT, connection proxies, distinct
listener addresses or namespaces that prevent an exact direct TCP correlation
are not inferred to match. Extra PG credential/TLS files and custom loaders
require separate configuration review. Unknown builds remain BLOCKED.

The smallest alternative for a permission-only gap is an operator-assisted run
of this same reviewed read-only probe in an **already authorized** service/operator
session, with the same independent identity inputs. No new grants, sudo commands,
service environment edits or restarts are part of this PR. Its sanitized output
is separate operator evidence, not an automatic workflow PASS or permission bypass.

If no stable observable backend connection exists, the current repository has no
way to extract historical dotenv values or prove pool identity remotely. Existing
`/api/health/ready` only runs SELECT 1 and cannot close that gap. The smallest future
instrumentation would execute the identity/role SELECTs through a checked-out
client from the **running backend's existing Pool**, under a read-only transaction,
and return fixed diagnostic codes against the independent expected identity via
an authenticated internal operator channel. It must never return credentials or
raw environment values and must release/rollback in finally. Such instrumentation
requires a separately reviewed application change and later authorized deployment;
it is **not implemented, deployed or activated here**. Until then, leave BLOCKED;
do not assume current `.env` matches the process or restart it to manufacture proof.

## Artifact contract, cleanup and output protection

Versioned fingerprints cover reviewed server/configuration/pool/importer artifacts,
lockfile, pg configuration and dotenv parser/entry/options implementations, built
from main `1cc79aaebfffa3f477dd967ed2727f7675c9c212` with TypeScript 5.9.3.
New builds require review and contract updates. Backend artifacts modified since
startup block verification. Trusted deployment files/metadata are assumed; this
is not attestation against a malicious server administrator rewriting history.

All failure paths reach finally: rollback after any BEGIN attempt, then close even
if connect or rollback fails. Connection errors mark failure rather than exiting.
Final PASS requires cleanup success. Remote stdout uses finite `DEV_DB_V1` codes;
only locally defined messages reach logs/summary. Arbitrary status text, unknown
codes, control bytes, oversized output, invalid ordering and inconsistent SSH exit
status are rejected. Runtime socket proof is mandatory in a success record sequence.
Raw output is never printed and is removed on exit. FAIL means observed mismatch;
BLOCKED means missing evidence/permissions or failed cleanup. SSH key discovery
retains the existing deployment's ssh-keyscan trust-on-first-use limitation.

## Validation

Run `npm run build` and `node scripts/ci/verify-dev-db.test.cjs`.
Fixtures cover the actual dotenv-only DATABASE_URL case with preserved `.env`,
launch overrides, a file edited after process start with a corroborated target,
wrong candidate endpoints, private read permission failures, socket ownership,
IPv4/IPv6 mapping, missing/mismatched/changing sessions, configuration races,
independent cluster mismatch, query permissions, cleanup and diagnostic injection.
Tests do not open live SSH/database connections. YAML, dispatch/concurrency
assertions, embedded Bash and Node syntax are checked separately.
The previously attempted broader backend suite hit environment EPERM restrictions
on socket listeners and subprocesses; no full-suite success is claimed here.
