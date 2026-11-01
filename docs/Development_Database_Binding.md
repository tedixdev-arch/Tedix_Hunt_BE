# G4c-2 development database binding

Prepared for review only. Do not dispatch until ChatGPT review is complete.
This workflow does not deploy, import, migrate, restart or escalate privileges.
It shares `dev-deploy` with the existing development deployment and uses only
its host, account and `DEPLOY_SSH_KEY`. There is no production target/input.

The administrator designated pgAdmin connection `tedixhunt_dev`. The owner verified
`tedix_hunt`, `tedix_app`, migrations 001–034, zero cities and no import history.
Connectivity alone and matching database/user names do not establish server identity.
The supplied evidence contains no numeric server identity; the workflow must remain
BLOCKED until independently obtained values are recorded as repository variables:
`DEV_PG_SYSTEM_IDENTIFIER`, `DEV_PG_SERVER_ADDR`, `DEV_PG_SERVER_PORT`.
From the existing administrator-designated pgAdmin connection, the administrator
can obtain these using read-only SQL (never copy a connection string):

```sql
SELECT system_identifier::text FROM pg_catalog.pg_control_system();
SELECT inet_server_addr()::text, inet_server_port();
```

Do not populate these from the backend under test. A null server address (Unix
socket), proxy endpoint or replica requires further independent identity review;
this verifier deliberately supports a directly comparable TCP endpoint only.
The cluster identifier and endpoint values are compared privately and withheld
from the report. EXECUTE on `pg_catalog.pg_control_system()` may be restricted;
the workflow reports that exact missing permission and never grants it or uses sudo.

The verifier reads systemd MainPID and the direct Node process launch environment
without printing it. It requires the deployment cwd, standard launch, unchanged
configuration files predating process start and the reviewed backend/importer Pool
configuration expressions. It reconstructs the same pg options using the launch
DATABASE_URL and PG variables, without importing any application entrypoint.
Custom Node/dotenv loaders block verification. If DATABASE_URL was loaded later by
dotenv, Linux /proc cannot expose the updated value: verification is BLOCKED,
rather than substituting today's .env for the running process configuration.
An administrator runtime configuration attestation would be needed for that case;
this task makes no changes to the service environment. This verifies configuration
binding, not inspection of an existing backend pool socket or importer execution.

SQL uses a bounded, repeatable-read, read-only transaction and SELECTs only, followed
by ROLLBACK. Checks cover database/current/session roles, independent cluster and
endpoint identity, exact migration IDs 032–034, catalog/reference tables, zero cities
and zero import records. A changed backend PID/start time invalidates the result.
Only fixed sanitized messages appear in logs and the Actions summary. FAIL means
an observed mismatch; BLOCKED means evidence/permissions/connectivity are insufficient;
PASS requires every check. Both FAIL and BLOCKED produce a non-success job.
The workflow does not claim that migrations 001–031 were reverified.

SSH host key discovery follows the existing deployment's ssh-keyscan pattern;
this is trust on first use, with the same existing deployment limitation.
