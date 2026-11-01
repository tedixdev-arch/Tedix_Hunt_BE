# G4c-1 — read-only development database preflight: blocked

Status: **BLOCKED — DEVELOPMENT DATABASE IDENTITY UNVERIFIED**

Status: **BLOCKED — SERVICE DATABASE BINDING UNVERIFIED**

Inspected latest main `1cc79aaebfffa3f477dd967ed2727f7675c9c212` on 1 November 2026,
independently resolved through GitHub. Related: Draft PR #102, unchanged.
This is the requested blocker-report fallback. No executable workflow is added:
a generic metadata probe is possible, but a complete preflight cannot safely
verify database ownership and importer binding with the available evidence.
No live preflight or Actions summary was produced. The table below is a
repository-evidence summary, not a claim about the installed environment.

| Check | Result | Evidence / missing operator evidence |
| --- | --- | --- |
| Existing development SSH connection | PASS (configuration only) | `.github/workflows/backend.yml`, job `deploy-dev`: host `tedixhunt-be-dev.anainfo.ai`, user `deploy`, key `DEPLOY_SSH_KEY`, path `/var/www/Tedix_Hunt_BE`. Connectivity not tested. |
| Deployment concurrency | PASS (configuration only) | Existing job uses `dev-deploy`. A future preflight must use that exact repository-wide group with cancellation disabled. |
| Independent development DB identity | BLOCKED | No trusted expected identity or independent verification contract was found. SSH hostname, database name, NODE_ENV and connectivity do not prove ownership. |
| Running service database binding | BLOCKED | Installed `tedixhunt-api` unit, drop-ins, execution identity, working directory and configuration precedence are not recorded in the repository. Deployment excludes server `.env`. |
| Importer configuration equivalence | BLOCKED | Source backend and importer both load `dotenv/config` and consume DATABASE_URL; this does not establish equivalence between the service process and a new SSH shell. |
| Installed revision and importer | BLOCKED | Requires bounded, sanitized server evidence. Source availability is not installed availability. |
| Applied migrations 032–034 | BLOCKED | Files exist in main; persistent `schema_migrations` was not queried. |
| Schema readiness | BLOCKED | Installed tables, completion columns, constraints, indexes and catalog readiness are unverified. |
| Database privileges | BLOCKED | Effective role and required object privileges are unverified. Never test permissions with writes, even inside a rolled-back transaction. |
| Approved authenticated API verification | BLOCKED | Geography routes require authentication and creator/organizer/admin role. No approved live identity and credential delivery procedure is established in repository evidence or PR #102. |
| GitHub development protection | BLOCKED | `deploy-dev` declares no environment. This does not prove that the development environment or its protections are absent. Available GitHub connector has no environment-inspection operation; its fetch endpoint rejected the environment API URL. |
| Diagnostic execution | BLOCKED | Explicitly not executed, as requested. No runtime PASS/FAIL asserted. |

## Evidence and safe implementation prerequisites

1. **Independent identity:** the infrastructure owner must provide an authoritative
   development resource binding, expected identity and a read-only comparison
   procedure. For example, a provider resource identifier independently tied to
   development plus its verified TLS/database endpoint binding, or a pre-existing
   protected per-database identity with independently recorded expected value.
   A PostgreSQL cluster identifier alone cannot distinguish databases in the same
   cluster; an identity copied with a clone is also insufficient. Do not derive
   the expected identity from the DATABASE_URL under test or create an identity
   marker in this task. Record evidence provenance and who controls the assertion.

2. **Service binding:** provide a sanitized operator attestation of the installed
   unit/drop-ins, service user, executable, working directory, environment-file
   paths, credential mechanism and precedence. Confirm what the deploy user may
   safely inspect. Do not paste unit contents, process arguments or environment
   dumps: any can contain secrets. Do not source an arbitrary server environment
   file as shell code. Establish a reviewed way to resolve only DATABASE_URL in
   memory and supply the identical effective configuration to the installed
   importer, accounting for dotenv paths, inherited overrides and PG/TLS options.
   If permissions prevent this, report missing evidence; do not expand sudo rights.

3. **Read-only probe contract:** once identity and binding are established, use
   existing installed tooling only, bounded connection/query/lock timeouts and
   an explicitly READ ONLY transaction. Run fixed metadata queries with no
   application bootstrap, migration runner or importer invocation. Inspect
   `schema_migrations` for `032_geographic_catalog`,
   `033_geographic_import_completion`, `034_geonames_kosovo_country`;
   verify actual catalog tables, completion columns, relevant constraints and
   indexes, including the reviewed XK constraint. Check effective schema/table
   and applicable sequence privileges using PostgreSQL privilege functions,
   including inherited roles/RLS as applicable; no trial INSERT/UPDATE/DELETE.
   Privilege metadata cannot guarantee that a future import will succeed.
   Source importer writes countries, imports, cities and names; use its reviewed
   installed revision to enumerate exact required privileges. Inspect installed
   artifacts without importing modules that may have side effects. Compare
   installed revision with the running process, rather than trusting a disk
   revision file alone. Keep raw exceptions and database results out of logs.

4. **API approval:** identify an existing approved development principal, required
   role, approved credential storage/delivery and expiration/refresh procedure.
   Verification must use approved authenticated GET requests only. Do not
   generate tokens, read signing secrets, log headers or call write endpoints.
   If no method is approved, keep this check BLOCKED.

5. **Actions controls:** operator evidence must confirm whether GitHub's
   `development` environment exists, required reviewers, self-review policy,
   branch restrictions and any bypass settings. Use existing access/settings
   evidence; do not create an environment just to inspect it. A future separate
   `Development Database Preflight` workflow must be dispatch-only, use only
   the development SSH connection, `contents: read`, and `dev-deploy`
   concurrency with `cancel-in-progress: false`. Establish independently
   trusted SSH host-key evidence; keyscan alone is not host authentication.
   Never use production credentials. Emit only fixed PASS/BLOCKED/FAIL rows
   into an always-run Actions summary. Any unavailable required evidence keeps
   the overall result blocked; connectivity alone is never success.

## Validation and boundaries

- Repository source reviewed: backend workflow, server/config/pool loading,
  importer, migration runner, migrations 032–034, geography route authorization
  and `docs/A1-deployed-setup.md`. The latter explicitly leaves service target
  verification pending; historical database observations are insufficient.
- `actionlint -version`: unavailable (command not found). No YAML changed,
  so there is no new workflow to lint. No runtime tests needed for this report.
- No SSH/database connection, secrets retrieval, token generation, installation,
  migration, import, deployment, restart, workflow dispatch or merge performed.
- Follow-up implementation requires the evidence above and separate review.
  **STOP for ChatGPT review.**
