# G4c — persistent development GeoNames import: blocked

Status: blocked before workflow implementation. STOP for ChatGPT review.
Inspected main: `1cc79aaebfffa3f477dd967ed2727f7675c9c212` (1 November 2026).
No persistent database connection, import, deployment, restart or workflow dispatch was performed.

## Evidence

- `.github/workflows/backend.yml`, job `deploy-dev`, uses host
  `tedixhunt-be-dev.anainfo.ai`, user `deploy`, directory
  `/var/www/Tedix_Hunt_BE`, secret `DEPLOY_SSH_KEY`, and concurrency
  `dev-deploy`. Its rsync excludes the server `.env`. Development deployment
  does not currently declare a GitHub environment. Production has a separate key
  and `production` environment; neither may be used for this task.
- The repository does not contain the installed `tedixhunt-api` systemd unit
  or a verified description of its environment loading and execution identity.
  Therefore the deployment shell's dotenv configuration cannot be assumed to
  match the running service's effective database configuration.
- `src/config/environment.ts` defaults NODE_ENV to development. That value,
  the SSH hostname, WEB_ORIGIN and a GitHub environment label cannot establish
  which persistent database is reached.
- `docs/A1-deployed-setup.md` explicitly leaves operator verification of the
  running service's database target pending. Its historical observation of
  `tedix_hunt` does not establish development ownership of the current target.
  Public health/readiness reports connectivity and revision, not database identity.
- No independently trusted development database identity assertion was found
  in repository configuration or migrations. No expected database identity,
  separate from the connection configuration being checked, is established.
- `src/scripts/importGeonames.ts` loads dotenv and uses DATABASE_URL.
  Its existing import is transactional, uses an advisory transaction lock,
  preserves locality mappings, and rejects mapped country changes requiring
  reconciliation. It does not modify localities, Templates or Hunt snapshots.
  Its CLI prints raw errors; a future remote wrapper must keep diagnostics
  secret-safe rather than forward arbitrary database errors to Actions.
- `src/routes/geography.ts` protects catalog status and city search with
  requireAuth and Creator/Organizer/Admin authorization. No approved live API
  verification identity or credential delivery mechanism is established here.
  Do not fabricate tokens with the service signing secret or weaken these routes.
- The managed workspace has no configured SSH credentials. Server configuration
  and GitHub development environment protection were not verified. Absence of
  evidence is not evidence that these are absent on GitHub/the server.

## Required evidence before implementation

The development operator must establish, without disclosing passwords,
connection strings, environment dumps or signing secrets:

1. An independently trusted assertion binding the actual connected PostgreSQL
   database to development, with a concrete read-only verification procedure
   and expected identity. A name or NODE_ENV check alone is insufficient.
   If no such assertion exists, its provisioning needs a separately reviewed
   infrastructure decision; this change does not invent one.
2. How the running systemd service obtains its effective database configuration,
   and how the existing deploy user can execute the installed importer against
   exactly that configuration without deployment, dependency installation or restart.
   Confirm installed revision, importer availability, filesystem permissions
   and database import privileges.
3. An approved authenticated API verification method for the development API
   using existing permissions, with credentials kept out of logs and artifacts.
4. Whether GitHub's `development` environment exists and which protection rules
   are configured. A future import job must declare that environment regardless;
   doing so does not imply reviewer protection exists.

## Workflow acceptance after blockers are resolved

Implement a separate workflow with only workflow_dispatch, fixed development
SSH configuration/key from backend.yml, contents: read, environment: development,
and concurrency coordinated with dev-deploy (without cancellation).
Do not modify backend.yml or use production credentials.

Before downloading/importing: establish the independent database identity and
service configuration binding; check connectivity, applied migration history
(including 032–034), required catalog schema and current catalog status.
Missing migrations must fail for a separately authorized deployment; do not
bootstrap or migrate the persistent database as a fallback.

Reuse official downloads and provenance recording in
`scripts/ci/download-geonames.sh`: exact URLs, UTC timestamps, bytes and SHA-256
for all source files and extracted input. Use temporary storage only and retain
no dataset, database dump or credentials in Git/artifacts.
Execute the existing deployed importer with bounded execution and generic,
stage-specific failures. Do not sync application code, reset/truncate/recreate
the database, register localities, approve Templates or restart the backend.

Verify committed import provenance and positive source-derived row count,
catalog readiness, exact GeoNames ID 681290, RO filtering and Cluj-Napoca search.
Verify the deployed authenticated API reports catalog ready and returns that
city under RO. Record source provenance, stage outcomes, import ID/count and
verification results in an always-run Actions summary, including failures.
Distinguish a rolled-back import from a committed import whose later verification
failed; never claim rollback after commit. Preserve application data and mappings
and account for concurrent legitimate application writes when checking preservation.

## Validation of this blocker report

- GitHub main SHA independently confirmed through the GitHub connector; local
  checkout matches. Local git fetch failed because the configured proxy is unreachable.
- `npm run build`: passed.
- `actionlint -version`: attempted; command is not installed. Network proxy
  failure prevents fetching a binary. No workflow YAML is changed by this report.
- No runtime/database test can establish development ownership without the
  missing trusted identity evidence. No live acceptance is claimed.
