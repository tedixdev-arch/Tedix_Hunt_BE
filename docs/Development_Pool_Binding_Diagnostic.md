# Development running Pool binding diagnostic (G4c-3)

The owner invokes **Verify development running Pool binding** in GitHub Actions.
No personal server SSH access, tunnel, Admin JWT, login, public diagnostic route
or reverse-proxy configuration is required. The workflow uses the existing
`DEPLOY_SSH_KEY`, `deploy@tedixhunt-be-dev.anainfo.ai` and `dev-deploy` concurrency.
It never deploys, restarts, grants permissions, migrates or imports GeoNames.

## Availability prerequisite — cannot instrument an existing process remotely

The current backend has no private control channel. The code in this draft must
first be reviewed and reach the running development backend through a separately
authorized normal rollout. This task does not perform or authorize that rollout.
A workflow alone cannot retrofit a live Node process with a private socket.
Until the code is running, the workflow reports `BLOCKED` /
`PRIVATE_DIAGNOSTIC_UNAVAILABLE`; a successful SSH connection is not proof.
Do not start a second backend, load the Pool in a CLI, inspect /proc or substitute
an importer connection. The public HTTP diagnostic from the first draft is removed.

At normal startup, **only explicit NODE_ENV=development** plus matching captured
configuration creates a Unix-domain socket at
`/tmp/tedixhunt-dev-db-binding-<service UID>/binding.sock`. Its directory is created
exclusively with mode 0700; the socket is mode 0600. Existing paths/symlinks are
never adopted, removed or chmodded. Normal shutdown removes the socket/directory.
A stale path after a crash blocks the diagnostic; clearing it requires a separate
operator maintenance decision and is not done by this workflow. Diagnostic startup
failure logs only a fixed BLOCKED code and leaves ordinary backend startup intact.
Production does not create a listener or filesystem path.

Filesystem access authorizes the existing SSH deployment OS identity; no JWT is
minted or application account bypass added to HTTP. **The backend service and
SSH deployment account must already have the same UID** for this implementation.
The installed systemd unit is not in the repository, so this is unverified.
If they differ or systemd PrivateTmp/namespaces hide the socket, verification stays
BLOCKED. No sudo, permission broadening, group changes or service configuration
changes are attempted. If this prerequisite is not already met, a separately
reviewed private access design/deployment change is needed. Same-UID local code is
trusted (as it already controls the deployment); filesystem authorization does
not defend against malicious code running as that identity or root.

## One-click procedure (after review and normal rollout)

One-time GitHub configuration, without direct server SSH access:

- Preserve repository variables `DEV_PG_SYSTEM_IDENTIFIER`, `DEV_PG_SERVER_ADDR`,
  `DEV_PG_SERVER_PORT`. They must come from the administrator-designated pgAdmin
  `tedixhunt_dev` record, never the backend or importer under test. No values are
  replaced or printed by this PR. Address is a literal IP; port a decimal string.
- Preserve existing secret `DEPLOY_SSH_KEY`. Add `DEV_SSH_KNOWN_HOSTS` containing
  the independently verified existing development server's OpenSSH known_hosts
  entry, obtained from its administrator through a trusted channel. This pins the
  SSH host identity instead of accepting a fresh network scan. If unavailable,
  the workflow safely blocks; do not use an unverified ssh-keyscan as evidence.
  This extra secret is host trust, not a new server credential or DB permission.
- Restrict repository write/Actions dispatch and secret access to trusted
  maintainers using the repository's existing controls. Only main can run this
  workflow; PR events never receive this SSH diagnostic job.

Invocation:

1. GitHub repository → **Actions** → **Verify development running Pool binding**.
2. **Run workflow** → branch **main** → **Run workflow**. There are no inputs.
3. Open the run's **Summary** for sanitized PASS / BLOCKED / FAIL JSON.
   PASS gives a green job; FAIL gives exit 1; BLOCKED gives exit 2. The summary is
   still published when verification fails. Do not dispatch Backend validation:
   its manual trigger is the existing production deployment workflow.

A newly added workflow becomes available after merging to the default branch;
this draft is stopped for ChatGPT review and has not been executed. Do not run it
from the draft or edit its branch guard to expose deployment secrets to other refs.

## What is proved

Actions sends a reviewed Node client over SSH stdin. It imports only Node built-ins,
checks socket/directory type, UID and modes, and sends the three independent values
to the private socket. It does not read .env, DATABASE_URL or process metadata,
instantiate a Pool or start a backend. SSH stderr and raw stdout are withheld;
a local renderer accepts only finite, size-bounded protocol responses. No raw
remote strings, connection details, credentials or environment values reach the
log or summary. SSH keys and raw response files are removed on exit. No artifacts
or request payloads are published.

Inside the already running backend, the retained parameterized SELECT uses its
existing singleton Pool, matching database `tedix_hunt`, current and session role
`tedix_app`, cluster system identifier, and server address/port in one query.
No application tables are read by the private mechanism. IPv6 comparisons use
PostgreSQL inet semantics. A null endpoint/incomplete identity blocks. Definite
mismatches return FAIL per check. All checks true return PASS. Permission denial
(SQLSTATE 42501) returns `BLOCKED` / `PERMISSION_PG_METADATA`, without grants.
Other query failures return `IDENTITY_UNAVAILABLE`. Client query timeout is five
seconds (not a server statement timeout). Socket/client/SSH timeouts are bounded;
one query at a time and one request per connection bound diagnostic concurrency.

PASS proves the sampled connection from the running Pool at invocation time,
not every future Pool connection, importer equivalence, migrations/catalog state
or GeoNames readiness. It does not authorize import. Filesystem and host-key
prerequisites remain explicit; workflow availability does not imply server readiness.

Validation: `npm run build`; `npx vitest run src/lib/development*test.ts`.
