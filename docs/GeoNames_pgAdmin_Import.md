# GeoNames SQL package for pgAdmin Web — Romania only by default

**Draft — STOP for ChatGPT review.** No persistent database import is authorized
by generating or testing this package. No deployment, SSH, production connection
or database credentials in GitHub are needed.

## Compatibility and review gates

The package uses PostgreSQL SQL accepted by Query Tool, without psql commands,
server filesystem COPY, extensions, restore ownership or new database objects.
It has been tested on disposable PostgreSQL 17 with baseline + migrations 001–034
and a restricted, non-superuser role with no schema CREATE permission. Synthetic
fixtures cover direct-importer equivalence, duplicate IDs across 500-row batches,
reimport, stale revisions, mapped
country-change rejection, preserved reconciliation, SQL quoting and rollback.

**pgAdmin Web compatibility is NOT yet established.** No particular pgAdmin Web
version, browser, hosting proxy, upload limit or timeout has been tested in this
PR. The actual `tedix_app` grants have not been inspected or changed. Therefore
persistent use is **BLOCKED pending review and an isolated pgAdmin Web trial**.
A successful workflow establishes SQL execution twice for its selected scope on its
disposable service, not browser compatibility. Check that run's acceptance.md;
this draft does not claim that an unexecuted workflow has passed.
G4c-5 local validation: build and 51 parser/package/catalog tests passed on disposable
PostgreSQL 17, including mixed-country Romania-only first/repeat execution,
exact direct-importer equivalence, zero non-RO cities and rollback. Official-data
size and Romanian city count are not yet measured: the task environment's proxy
blocks official downloads (HTTP 403), and GitHub CLI workflow dispatch returns
Forbidden. No tested official-data artifact has been published during preparation.
See `GeoNames_Romania_Package.md` for task evidence and remaining blockers.

Before persistent use, test the exact artifact through the owner's pgAdmin Web
version against an isolated database with migrations 001–034 and the same ACLs.
Record SQL bytes, pgAdmin/browser versions, upload success, elapsed execution
time, second-import result and canceled/error rollback. If the full file cannot
be loaded/executed, stop. Do not split the statement or import tables separately.
The smallest fallback is to use this same SQL file from a desktop PostgreSQL
client over an owner-approved development connection, with `tedix_app`; if no
such connection is available, infrastructure must enable the pgAdmin limits or
provide an approved one-off client route. Never replace this with a plain dump.

## Generate and download (after review)

1. In GitHub, open **Actions → GeoNames pgAdmin Import Package → Run workflow**.
   Choose the reviewed branch and **Romania only** (the default). **Worldwide**
   remains an explicit option. This manual-only workflow downloads the four
   official files from https://download.geonames.org/export/dump/ and records
   their hashes and timestamps. It only connects to a disposable service.
2. Wait for every check to pass. Open that run and download the
   **geonames-pgadmin-romania-only-…** (or **…-worldwide-…**) artifact before its seven-day expiry. Unzip it locally.
   A failed package/acceptance step publishes no import artifact.
3. Keep `import.sql`, `manifest.json`, `provenance.md`, `acceptance.md`,
   `execution.md` and `import.sql.sha256` together. The manifest contains accepted
   scope, country code, dataset label, accepted row count, combined source hash
   and uncompressed SQL bytes. The SHA-256 file
   verifies `import.sql`; its path prefix is the CI directory, not your computer.
   GeoNames attribution: **GeoNames (CC BY 4.0)**, https://www.geonames.org/.

## Import with pgAdmin Web (only after the isolated trial and approval)

1. Open the development server in pgAdmin. Select database **tedix_hunt** and
   open **Tools → Query Tool**. Check the connection uses **tedix_app**. Run:
   ```sql
   SELECT current_database(), current_user, version();
   SELECT id FROM public.schema_migrations ORDER BY id;
   SELECT count(*) FROM public.geographic_cities;
   SELECT count(*) FROM public.geographic_imports;
   ```
   Stop on a wrong database/user or missing migrations. A database name alone
   does not establish server identity: use the independently verified development
   connection. Do not connect to production.
2. Use Query Tool's **Open File** dialog and its upload option to upload/open
   `import.sql`. Labels vary by pgAdmin version. It belongs in Query Tool;
   do not use table Import/Export or database Restore. Verify it loaded fully.
3. Enable **Auto commit**, finish any previous transaction, clear text selection,
   then execute the **entire file once**. The file contains one `DO` statement.
   Wait for successful completion; the UI can be busy for several minutes.
4. Check:
   ```sql
   SELECT source,dataset,sha256,row_count,completed_at
   FROM public.geographic_imports ORDER BY imported_at DESC LIMIT 2;
   SELECT count(*) FROM public.geographic_cities;
   SELECT name,country_code FROM public.geographic_cities WHERE geoname_id=681290;
   ```
   Compare row_count/hash with the manifest, completed_at must be non-null, and
   Cluj-Napoca must be in RO. Retain the artifact and successful Messages output.

## Coverage

**Romania only** selects `country_code = RO` in the existing source reader before
SQL batches are generated. It retains the same populated-place feature rules as
the validated cities500 importer, so it is a Romanian subset of cities500, not
all Romanian settlements and not a complete worldwide GeoNames catalog. The SQL
header, dataset metadata, manifest, artifact name and workflow summary identify
coverage. All four original source files remain hashed in full for provenance;
filtering does not rewrite them. The manifest's `rows` and `bytes` are actual
accepted source rows and generated SQL bytes, not worldwide estimates.

The workflow checks every Romanian source city and normalized alias, admin
label, coordinate, GeoNames ID and revision, plus zero non-RO cities/aliases on
the disposable database after both executions. On a pre-populated destination,
this package updates its Romanian rows and preserves existing non-RO rows; it
does not turn an existing worldwide catalog into a Romania-only catalog. The
existing API's `ready` status describes a completed import, not worldwide coverage.

## Transactions, retry and rollback

Validation and normalized aliases come from `readGeonames` / `importCities`, the
same code as the existing CLI. The SQL adapter renders the same batch commands
and evaluates the same country-move guard on the destination. It preserves
country relationships, existing localities and reconciliation fields, aliases,
source timestamps, attribution, source hash and completed import metadata.
It creates no application locality, Template or Hunt rows.

One statement is one atomic transaction in auto-commit mode. The existing
advisory transaction lock serializes imports, and row locks protect source
country reconciliation. A SQL error, permission error or server cancellation
rolls back this statement, including its import metadata. In manual transaction
mode nothing is final until COMMIT; ROLLBACK discards it. If Query Tool says the
transaction is aborted, run `ROLLBACK;` before retrying.

Repeating the same package keeps city identities and semantic data unchanged,
but intentionally creates a new completed import record and refreshes accepted
cities' import IDs, exactly like the existing importer. Older revisions do not
replace newer aliases. Mapped source-country changes fail rather than silently
moving the mapped city. A completed commit cannot be undone by ROLLBACK; there
is no destructive "undo" script. Use a separately approved backup/restore plan
if post-commit reversal is needed. A browser disconnect is not proof of rollback:
reconnect and check metadata before retrying or reporting success.

## Permissions, upload size and time limits

The tested disposable role has schema USAGE, SELECT on schema_migrations and
SELECT/INSERT/UPDATE/DELETE on countries and all three geographic tables. No
superuser, schema CREATE, TRUNCATE, server-file access or role changes are used
by the package. PostgreSQL must permit PL/pgSQL DO, its built-in UUID default,
clock_timestamp, advisory locks and the ordinary conversion/JSON functions.
Permission failures must be resolved by the owner; this package grants nothing.
Matching role names alone do not prove matching permissions.

Query Tool uploads first to pgAdmin's server-side storage; browser memory,
pgAdmin storage quotas/MAX_UPLOAD_SIZE, reverse-proxy request-body limits and
available server RAM can all limit the uncompressed SQL. Check the deployed
configuration; there is no universal safe upload size. Hex-encoded parameters
protect SQL delimiters but increase size. The generator refuses more than
512 MiB uncompressed; that ceiling is a build safeguard, **not a tested pgAdmin
limit or a guarantee that official data fits**. File size is recorded in the
manifest and execution report. A limit failure leaves no newly published file.

Query Tool sends the entire single statement to PostgreSQL. Compilation and
execution can use substantial browser, pgAdmin and database memory. PostgreSQL
statement_timeout/lock_timeout, pgAdmin timeouts, reverse-proxy timeouts and
idle-session limits may interrupt it. The package does not disable timeouts.
Use execution.md as a disposable-service measurement only, not a prediction for
the development server. On upload, memory, permission or execution failure,
stop and keep the error for review; do not remove checks, aliases or transaction
boundaries to make it fit.
