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
RO/HU filtering, normalized aliases taken from the downloaded Cluj record (raw, normalized and uppercase
search variants), exact four-input
import provenance, completed positive row counts, no application locality creation,
and identical full city/alias content and mappings after the second import.
Klausenburg and Kolozsvár presence in the official alternate-name field is reported;
absence is not a failure. Every source name is checked in normalized storage;
names meeting the two-character search minimum must also be searchable, with
keyset pagination to avoid first-page assumptions. Imported coordinates must
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
