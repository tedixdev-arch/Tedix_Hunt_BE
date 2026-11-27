# GeoNames Catalog Import — Phase 1

After merge, select **Actions → GeoNames Catalog Import → Run workflow**.
This separate workflow has only `workflow_dispatch`; a push or merge never runs it.
Do not dispatch the existing Backend validation workflow for this task: it also has a production deployment job.

The job downloads official `cities500.zip`, `countryInfo.txt`, `admin1CodesASCII.txt` and `admin2Codes.txt` over HTTPS directly from
https://download.geonames.org/export/dump/ and extracts `cities500.txt`.
Its always-run summary records each successful download's URL, UTC timestamp,
byte count and SHA-256, plus the extracted city's input hash and step outcomes.
Hashes record the observed source snapshot; they are not upstream authenticity signatures.
Attribution: [GeoNames](https://www.geonames.org/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
No source datasets or database dumps are committed, cached or uploaded as artifacts.

A fresh PostgreSQL 17 service uses the existing backend CI baseline and compiled
migrations. All connections target loopback and the dedicated `geonames_ci` database.
The ephemeral, masked job token supplies the disposable service password; no
repository database secrets, production/development connection, deployment or restart is used.
The job has only read permission and checkout does not persist credentials.

The existing `npm run import-geonames` runs twice against identical files.
Acceptance checks the initial unavailable state, ready state, Cluj-Napoca (681290),
RO/HU filtering, bounded source-derived alias searches, exact four-input
import provenance, completed positive row counts, no application locality creation,
and identical full city/alias content and mappings after the second import.
Klausenburg and Kolozsvár presence in the official alternate-name field is reported;
absence is not a failure. Every source name is checked in normalized storage;
search acceptance selects at most two distinct non-primary alternate names, ordered
by normalization changes then code units. It falls back to the ASCII field only
when no eligible non-primary alternate exists. Selected original and normalized
variants must satisfy the API query limits (2–100 characters, normalized length
at least two). Primary prefix/full-name discovery plus one uppercase primary query
covers case-insensitivity; variants are deduplicated, for at most seven queries
per country. Keyset pagination avoids first-page assumptions. Imported coordinates must
match the official record as well as the expected Cluj geographic center.
Only import IDs/timestamps may change. Acceptance calls existing catalog model reads;
it does not bypass or change API authorization. Existing API/authorization tests remain unchanged.

Downloads, baseline SQL (ON_ERROR_STOP), migrations, imports and acceptance failures
stop dependent steps and fail the job. No fallback, source patching or synthetic
acceptance data is permitted. The existing importer deliberately rejects missing
administrative metadata or invalid rows; official upstream inconsistencies must
remain visible as a failed run for a separately reviewed importer correction.
An always-run summary can be absent if GitHub cancels/terminates the runner itself.

Real-data acceptance must run manually on GitHub Actions after merge. The Codex
environment cannot reach its configured network proxy or use the local Docker
socket, so implementation-time checks do not claim a successful worldwide import.
A green backend PR test run alone is not official-data acceptance.

## Dev database: worldwide import

The dev database starts with the Romania-only package. To add every GeoNames country, region and city
(`cities500`), use the two existing manual workflows. Nothing runs automatically.

1. **Actions → GeoNames pgAdmin Import Package → Run workflow**, scope **Worldwide**. It builds `import.sql`
   with the tested importer, runs it twice on a disposable database and checks idempotency. Note the run id,
   the run attempt, and the sha256 in `import.sql.sha256` of the `geonames-pgadmin-worldwide-<run>-<attempt>`
   artifact. The artifact expires after 7 days.
2. **Actions → GeoNames dev import → Run workflow** with mode `check` (read-only preflight).
3. Run it again with mode `import`, scope `worldwide`, the run id, attempt and sha256 from step 1, and
   confirm `import-worldwide-into-tedix-hunt-dev`.

The dev script (`scripts/ci/dev-geonames.mjs`) runs the package in one transaction and commits only if the
number of Localities and every existing city-to-Locality link (including canonical Cluj-Napoca) are unchanged
and no Romanian city disappears. Otherwise it rolls back (exit 5). The import updates existing catalog rows in
place, so rerunning the same package creates no duplicates; each run adds one `geographic_imports` record.

### Low-memory alternative on the dev server (`import-files`)

The worldwide `import.sql` is one ~485 MB statement. PostgreSQL must hold all of it in memory, which can run a
small server out of memory (the dev box: 4 GB RAM, no swap, PostgreSQL on the same machine). Instead,
stream the four official files through the deployed importer, which reads `cities500.txt` line by line and
writes in batches of 500, inside the same preservation-checked transaction:

1. Run **GeoNames pgAdmin Import Package** with scope **Worldwide** and note `sha256` in its `manifest.json`
   (the fingerprint of the four input files that CI just tested). GeoNames files change daily, so download
   them on the server the same day.
2. On the dev server, use a disk folder, not `/tmp` (tmpfs is held in RAM):
   ```
   mkdir -p /var/tmp/tedix-geonames && cd /var/tmp/tedix-geonames
   for f in cities500.zip countryInfo.txt admin1CodesASCII.txt admin2Codes.txt; do
     curl --fail --proto '=https' -sSO "https://download.geonames.org/export/dump/$f"; done
   unzip -o cities500.zip cities500.txt && sha256sum *
   ```
   Compare the hashes with that run's `provenance.md`.
3. Copy the reviewed `scripts/ci/dev-geonames.mjs` to `/var/tmp/tedix-geonames/`, then from the deploy directory:
   ```
   cd /var/www/Tedix_Hunt_BE
   node /var/tmp/tedix-geonames/dev-geonames.mjs check
   node /var/tmp/tedix-geonames/dev-geonames.mjs import-files /var/tmp/tedix-geonames <manifest sha256>
   ```
   It refuses to write unless the four files match the fingerprint (exit 6). It commits only if the Localities,
   city links and Romanian cities are preserved; otherwise it rolls back (exit 5, or exit 1 on an importer error).
