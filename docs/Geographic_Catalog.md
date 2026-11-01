# GeoNames catalog and Creator city selection

Base: main cf2a148debce1a5ac9def467a0e5a5020cae18bf, including merged #96. One draft BE PR; stop for ChatGPT review. No FE, merge or deployment.

## Existing versus required gap matrix (before implementation)

| Inspected contract | Existing | Required change |
| --- | --- | --- |
| countries/localities; Geography model/routes; C6b-1 | RO reference; active registered UUID search, substring/case only, 50 cap | Separate worldwide source identities, aliases, indexed normalized prefix, bounded paging |
| C6a hybrid/provider storage | Manual proposals; Mapbox persistence blocked | GeoNames local import; Mapbox remains visual only; no entitlement assumed |
| C6b-3 proposals | Creator supplies context, coordinates, evidence; Admin accepts | Ordinary city selection requires none of these; Admin registration from trusted catalog stays separate |
| C6b-4 binding | Local versions bind registered UUID and server snapshot | Catalog ID never substitutes for localityId; explicit resolve/registration state |
| C6b-5 revision/approval | Exact reviewed version, retained authority, suspension and material-geography checks | Preserve every rule and existing immutable snapshot |
| C7 discovery/selection | Shared eligibility resolver; exact approved version selected atomically | Public availability boolean must use same resolver; search independent of inventory |
| Creator creation/approval | Creator-owned draft, independent Admin approval | Registered city can bind existing save API; unregistered city waits for Admin registration |
| Signal: Cluj-Napoca | Protected category-null content; no seeded canonical locality | Never classify/rewrite Signal; reconcile existing city UUID before any new registration |
| FE geography.ts (read only) | countries(), search() registered localities, get(UUID) | Add city search/resolve calls; retain existing registered API for compatibility |
| FE Master Execution Plan | F7/C6b-2 storage blocked; G4/D10 governance/FE gates distinct | GeoNames replaces proposed provider branch only; does not close G4/D10 or enable publication |

Inspected BE C6a, C6b-1/3/4/5 contracts and implementation, C7 contract/implementation, Creator/Organizer models/routes, Signal documentation/content, schema, migrations and Mapbox restrictions. FE source read only: src/services/api/geography.ts; Master Execution Plan blob d59951c7ae1093a8ffc0ff4436e2fcd59213d800. Existing C6a no-world-import wording describes its earlier slice; the current user request explicitly authorizes a separate GeoNames import.

## Source, licensing and import

Proposed permanent source: [GeoNames](https://www.geonames.org/), [download catalog](https://download.geonames.org/export/dump/), [dataset README](https://download.geonames.org/export/dump/readme.txt), [license](https://creativecommons.org/licenses/by/4.0/). GeoNames distributes its geographic database under CC BY 4.0, permitting local storage and adaptation with attribution; it provides data as-is. Preserve attribution and license links in FE display, exports and redistributed copies, and identify normalization/filtering as modifications. No Mapbox results, provider credentials, billing changes or permanent-storage entitlements are introduced.

Preferred bounded worldwide source is `cities500.zip`: populated places above 500 inhabitants and relevant administrative seats, rather than every historical settlement. This is intentionally **not every village**. Use `countryInfo.txt`, `admin1CodesASCII.txt`, `admin2Codes.txt` from the same dated snapshot. The parser accepts official 19-column city TSV, only current settlement codes PPL, PPLA/PPLA2–5, PPLC, PPLG, PPLL, PPLR and STLMT in feature class P. Sections of cities, farms and abandoned/destroyed/historical places are excluded. It keeps primary, ASCII and comma-separated alternate names. Missing country metadata still aborts. Administrative names are optional display labels: resolve admin1 by the exact country/admin1 key and admin2 only by the complete country/admin1/admin2 key. Join available nonblank labels in admin2, admin1 order; if neither is available, use the verified country display name from countryInfo.txt. Missing, blank or unmatched labels and incomplete administrative codes never discard an otherwise valid city. Do not infer a parent code, use another country/parent, substitute a modern municipality, or invent subdivision names. Preserve the original admin1/admin2 strings (including empty strings and `00`), GeoNames ID, country, coordinates and provenance. This context is a display fallback, not a claim that the country is an administrative subdivision. GeoNames `alternateNamesV2` language/preferred flags are not consumed in this slice; embedded alternate names suffice for search.

Operator procedure (server only, independent of Creator browser):

1. Obtain and retain immutable dated input files and GeoNames's contemporaneous README/license from the official source. Unzip `cities500.zip` outside Git. Review coverage and attribution before operational import. No source file is downloaded automatically by the app.
2. Apply normal migrations. Use a dedicated database operator account, never browser credentials. Run `DATABASE_URL=<operator connection> npm run import-geonames -- /data/cities500.txt /data/countryInfo.txt /data/admin1CodesASCII.txt /data/admin2Codes.txt`.
3. The process streams city rows, holds only country/admin dictionaries and batches of 500 cities, hashes all four input streams with boundaries, and records dataset, SHA-256, attribution and import timestamp. Keep input files immutable throughout hashing/import. A transaction/advisory lock makes failures invisible and retries safe; imports serialize. For very large deployments schedule this operator transaction outside peak authoring times because country locks serialize registry writers.
4. Repeat against a newer snapshot for updates. GeoNames ID is the stable primary key; UPSERT preserves mapping UUIDs. A mapped source ID moving countries aborts for explicit reconciliation. Same/newer source dates refresh city data and aliases; older revisions cannot revert them. Repeated imports create audit runs, not duplicate cities. Omission from a later feed does not delete/deactivate anything; retirement/reconciliation needs a separately reviewed explicit operation. ANALYZE `geographic_cities` and `geographic_city_names` after substantial imports.

The geographic import never writes `localities`, Template versions/reviews/pointers or Hunts. Country references are added from source metadata only when ISO membership passes the existing countries constraint; existing country labels are preserved. No production data or worldwide dataset is committed. Test cities are synthetic, except the explicit Cluj compatibility identity/center fixture; they are not shipped as catalog seeds.

**Operational blocker:** GeoNames/download hosts are outside the configured network allowlist, so the official current files and README were not retrieved here. No live worldwide import or completeness/quality acceptance is claimed. Obtain/review a pinned snapshot before operational use; the parser still fails on malformed rows, invalid identities/coordinates and missing country metadata; optional administrative label gaps use the fallback policy above. The license basis above must be checked against that retained snapshot. This does not block review of the importer/API implementation.

## Database and performance

Migration 032 and fresh schema add `geographic_imports`, `geographic_cities` and `geographic_city_names`. Source numeric IDs are JSON strings (never UUIDs). Country/admin codes, representative center, population, source modification date and provenance remain in the catalog; internal provenance/audit is not exposed. There is no backfill of approved localities, Signal, Template versions or Hunt snapshots.

Normalized aliases use Unicode NFKD, combining-mark removal and lowercase with explicit ß/ł/æ/ø folding; original Unicode names are retained. No transliteration of every script is promised; GeoNames ASCII/alternate names supply additional spellings. `(country_code, normalized_name text_pattern_ops, geoname_id)` supports literal prefix ranges, plus a source-ID primary key and country index. The search materializes at most limit+1 distinct matching IDs before joining city records. Very common prefixes can still sort many **matching** alias entries; no whole-world fuzzy scan or external infrastructure is used. Ordering is numeric source ID, deterministic across name/population changes. Typo tolerance is deferred: only indexed prefixes/aliases are promised.

City reads have an authenticated per-account token bucket: 120 requests/minute capacity/refill, 10,000 retained identities maximum, conservative 429 on capacity with Retry-After. Uses the existing TokenBuckets implementation and persisted-role middleware. Budget is per process (multiply by replica count); this is bounded autocomplete abuse protection, not distributed bot prevention. Responses are private/no-store.

## Canonical reconciliation and smallest contract adjustment

`POST /cities/{id}/resolve` with an empty body is explicit Creator/Admin selection, never an import side effect. It rechecks persisted actor/roles and locks Country → catalog entry → existing locality. Any existing mapping is reused; inactive registry records return contact_admin and cannot pass existing binding gates.

For an unmapped source record, same-country name/alias candidates are compared after normalization (punctuation ignored for duplicate detection). Only one candidate with exact normalized primary name, context and numeric coordinates can auto-map. Matching by proximity alone is forbidden. Ambiguity, descriptive differences or geographic differences require explicit Admin reconciliation. No candidate means registration_required. Reads do not write mappings.

Admin registration body is exactly `{create:true,reason}` or `{localityId:"existing UUID",reason}`. Creation is blocked if any same-name/alias or exact GeoNames-provider candidate exists, including inactive ones. Admin may explicitly confirm a same-country existing UUID; this retains its labels/coordinates/versions and records actor/reason/time. Audit stores the authenticated actor UUID as a historical identifier without adding an account-deletion FK. One locality UUID cannot map to two source IDs. Established mapping cannot be rebound by this API. Admin lookup/reconciliation uses the existing registered-locality search; no private evidence is exposed through public city reads. Country locking serializes creation with existing manual-proposal writers. Source IDs for genuinely duplicate GeoNames entries require source/manual reconciliation, not a second local identity.

This is the minimal change to C6a's provider-selection branch: locally stored, storage-permitted GeoNames data replaces the blocked Mapbox persistence proposal; canonical registration remains an explicit application operation. It is **not Template approval**. C6b server-created locality snapshots, material-change checks, independent exact-version review, retained authority and suspension remain intact. The approved-Template boolean means at least one currently **C7-eligible public artifact**, computed through the existing shared resolver; it deliberately does not disclose suspended approvals/private candidate/review information. Availability is advisory and writes still revalidate C7.

For an unregistered city, continuing into bound Local Template submission is blocked until Admin registration; Creator may retain an unbound draft through existing APIs. No automatic approval, custom Hunt publication, Participant gameplay, GPS, checkpoint-radius or scoring change is included. The protected Signal Template stays category-null and never supplies an automatic catalog UUID. A matching pre-existing Cluj locality is reused; Signal itself is not classified or rewritten.

## Exact FE integration instructions (subsequent FE PR)

Existing `GET /api/geography/countries` and `/localities` and UUID lookup remain backward compatible. The FE's current geography service must add the following calls rather than treating GeoNames IDs as registered UUIDs:

1. Fetch countries. These are supported reference countries, not eligible Template inventory; after import the set expands.
2. Search `GET /api/geography/cities?countryCode=RO&q=cluj&limit=20`. Require two normalized characters, debounce and cancel/ignore stale responses. Empty/one-character/unknown/extra parameters return 400. Max query 100 characters, limit 1–50. Page with `after=<nextAfter>`; reset on country/query change. Last page nextAfter=null. No total count or country dataset download.
3. Display name, administrativeContext and countryDisplayName, plus `GeoNames (CC BY 4.0)` attribution linked to GeoNames/license. Never auto-select the first same-name city. Center Mapbox using returned longitude/latitude; they are city centers, not route/safety certification.
4. On explicit city selection, call `POST /api/geography/cities/{geographicId}/resolve` with `{}`. A mapped response contains geographicId, source, attribution, public labels/coordinates, localityId, registeredActive, registrationState, nextAction and hasApprovedLocalTemplate. Unmapped response contains geographicId, null localityId, registrationState `registration_required`/`reconciliation_required`, and nextAction `request_registration`/`contact_admin`. Do not ask the Creator to type geographic facts or proposal evidence. A registration request UI/notification workflow is not added by this PR; show the Admin-required state and allow draft work only where existing rules permit.
5. For `registered`/`bind_locality`, send **localityId UUID** beside `content`/`category:'local'` in the existing Creator create/version request. Do not put catalog fields in content or forge a localitySnapshot. Existing version omission inherits the prior pair; explicit localityId captures a fresh server snapshot. Handle inactive/state conflicts by refresh; city search does not authorize submission or approval.
6. Organizer remains Country → registered UUID → C7 eligible list/detail → explicit exact-version PUT `/api/hunts/{id}/local-template`. hasApprovedLocalTemplate is an availability hint, never approval authority. A Creator capability alone does not grant Organizer Hunt creation/selection rights. Continue using the saved exact approved Template map preview for Organizer selection.

Examples: country RO, q cluj → Cluj-Napoca — Cluj County, Romania, `geographicId:"681290"`. A real import's context can include municipality and county metadata; FE must display returned context without assuming one subdivision. Unregistered and registered-with-no-approved-Template are different valid states. City get/resolve unknown ID → 404; malformed input → 400; missing auth → 401; wrong capability → 403; conflicts → 409; budget exhausted → 429 + Retry-After. Runtime Swagger documents all implemented operations. No private draft, answer, approval actor/reason, candidate version, import manifest or reconciliation reason is returned.

## Initial PR acceptance coverage and results

`src/routes/geographicCatalog.integration.test.ts` runs actual authenticated Express calls and SQL against a disposable PostgreSQL 17 database. There are 17 tests, covering the requested cases:

| Requirement | Evidence |
| --- | --- |
| Country filtering; city autocomplete | RO/US same-name isolation, prefix versus substring, literal wildcard escaping |
| Unicode/diacritics; alternate names | Șimleu/Simleu and Kolozsvár/Kolozsvar; original labels preserved |
| Duplicate city names | Distinct regional IDs; punctuation variants cannot create a duplicate Cluj |
| Stable identifiers; idempotence; updates | Same GeoNames ID and UUID across repeated/newer imports, replaced aliases, stale-source rejection, mapped-country change rejection |
| Pagination/bounds; invalid requests | Stable numeric ID pages; 50 cap with multiple matching aliases, invalid query/cursor/limit/UUID/extra fields |
| Unauthorized operations | Anonymous, Participant, guest, revoked/blocked; Organizer cannot resolve; Creator cannot register; persisted actor/roles rechecked on writes |
| Existing mapping; ambiguous reconciliation | Exact Cluj mapping, two candidates require explicit Admin identity choice; creation conflict |
| Cluj-Napoca compatibility | Existing UUID reused, no competing locality or Signal mutation |
| Approval preservation; Organizer eligibility | Real submission/independent approval, same C7 availability and exact-version selection after import |
| Historical snapshots | Signal history and selected Local Hunt rows unchanged across catalog updates; migration fingerprint check |
| Import interface; failure; concurrency; abuse | Official-format synthetic TSV with country/admin joins; missing country metadata aborts, optional admin labels fall back; invalid import rolls back; concurrent registration creates one UUID; prefix index; 429 budget |

Validation on disposable local PostgreSQL only:

- Full BE suite: **69 files / 1,517 tests passed, zero skips**.
- Final focused catalog verification: **17 passed**, including source-country and audit constraint checks.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- Compiled migrations: **32 applied; repeat zero**. Independent full-schema bootstrap: passed, including catalog table/index definitions.
- Runtime Swagger: **80 paths**, four new catalog operations, resolved local references; proposed gameplay operations absent.
- Existing pg concurrent-query deprecation warning remains; no pg9 change in this PR.

Reproduce with `TEST_DATABASE_URL=<disposable PostgreSQL CREATEDB connection> npm test -- --reporter=dot`, then typecheck/build, then `TEST_DATABASE_URL=... node docs/validate-participant-access.mjs`. The migration checker creates/drops independent databases. New synthetic parser fixtures are temporary and removed after the test.

Direct Git transport could not reach the inherited proxy. GitHub connector reads restored #96's exact tree `6af8dead9610505c9fd25a796ebdda41cc411c77`; the temporary local restoration commit is excluded from delivery. The PR commit has actual main as its sole parent and its remote complete tree is compared with the locally tested tree.

Remaining limits: official-source snapshot/README retrieval and worldwide coverage validation; typo tolerance; explicit retirement/remapping of source identities; registration-request notification UX; distributed query budgets. G4/D10 rollout/governance and FE/deployed acceptance remain separate. None permits bypassing C6b/C7. **STOP for ChatGPT PR review; do not merge or deploy.**

## PR #97 correction review

The Actions `test` job for `e0a73e0`, run [41248078184](https://github.com/tedixdev-arch/Tedix_Hunt_BE/actions/runs/41248078184), failed at **`npm test`** (step 10), not build/migration/install. Exactly one test failed: the official-format TSV parser fixture at line 144 called `mkdtemp('work/geonames-')` without creating `work/`. CI's fresh checkout had no such directory and Node returned ENOENT. Local scratch logs had created it and masked the missing precondition. A fresh archived checkout reproduced the exact failure (16 passed, one failed). The test now creates its own parent with recursive mkdir and retains every parser/database assertion and cleanup. CI is unchanged; no retry, skip, timeout relaxation or test removal.

Migration **033_geographic_import_completion** adds nullable `completed_at`/positive `row_count` as an all-or-none pair. No existing import is marked successful by migration. The importer records completion only after the entire nonempty stream has been processed; completion, provenance, aliases and city writes commit atomically. Empty/invalid/failed imports cannot announce readiness; uncommitted success cannot be seen by the API. An installation that ran the original PR version must apply 033 and successfully rerun import before readiness can be claimed.

**FE readiness contract:** first call authenticated `GET /api/geography/catalog-status` → `{source:"geonames",status:"not_imported",nextAction:"import_catalog"}` or `{source:"geonames",status:"ready",nextAction:null}`. Requires the existing Creator/Organizer/Admin read capability and shares the city budget/no-store behavior. Countries remain supported reference countries, not evidence of imported city coverage. Before successful committed import, valid city search/detail/resolve/registration calls return **503 `{error:"catalog_not_imported",catalogStatus:"not_imported",nextAction:"import_catalog"}`**, never an apparently operational empty catalog. Model-level checks also protect internal callers. Do not show city selection as available while not_imported; show the operator-required state. Ready means committed imported data is searchable, not worldwide coverage, source-quality certification, Template approval or deployment acceptance. Existing registered-locality APIs remain available separately.

C6/C7 recheck: Creator/Admin resolve may reuse a canonical UUID but never creates a new locality automatically. Only a persisted active non-guest Admin can create/reconcile; model checks deny direct Creator/Organizer/revoked/blocked callers too. This source registration does not decide a manual proposal, approve a Template, grant Creator capability to an Admin, or grant Organizer authority. Catalog numeric IDs cannot be passed as localityId. Inactive registry UUIDs remain contact_admin and existing C6b binding refuses them. New registered UUIDs without independent approval remain absent from C7. Independent exact-version approval and Hunt source pinning are unchanged, with existing full regression coverage retained.

Official source availability was rechecked: no cities500/countryInfo/admin metadata files exist in the attached workspace, and current enforced policy excludes `geonames.org` and `download.geonames.org`. No unofficial mirror or invented production data was substituted. The original operational source/license/coverage blocker remains in force. Tests use explicitly synthetic official-format TSV only; operational readiness has not been claimed for any deployed catalog.


Correction validation from a fresh archived checkout (no pre-existing `work/`): **69 files / 1,519 tests passed, zero skips**, including **19 catalog integration tests**. Typecheck/build and diff checks passed. Compiled migrations: **33 applied; repeat zero**; independent fresh-schema bootstrap including completion columns passed. Runtime Swagger: **81 paths**, new readiness operation and city 503 responses checked, all local references resolved. Original Actions failure was reproduced independently before the fix. The GitHub Actions workflow and every existing test remain enabled and unchanged in strictness. The corrected code tree is pushed only to existing PR #97 for ChatGPT re-review; no merge, deploy or FE changes.

## Optional administrative labels: importer correction

GeoNames 363341 is **Kakavijë, Albania**, feature PPLA3, center 39.90778 / 20.35833. The [official GeoNames search](https://www.geonames.org/search.html?country=&q=Kakavije) lists Gjirokastër County and the older district Rrethi i Gjirokastrës. A [historical exported record copy](https://github.com/rancheta/countryRegionCityJSON/blob/85ebdab0a59c43b3866d82b2ede2a916b5afca8d/region_city_data/Albania/Qarku%20i%20Gjirokastr%C3%ABs.json) preserves country `AL`, admin1 `45`, admin2 `06`, modified `2012-06-06`. The official [admin1 dictionary](https://download.geonames.org/export/dump/admin1CodesASCII.txt) contains `AL.45` → Gjirokastër County. The current official [admin2 dictionary](https://download.geonames.org/export/dump/admin2Codes.txt) lists modern municipality keys under `AL.45` (including `AL.45.10944393`), but no `AL.45.06`.

This identifies the legacy **admin2 label join `AL.45.06`** as the evidenced mismatch, rather than an invalid city ID, country or coordinate. The original throw combined admin1/admin2 failures and concealed which key failed. With these inputs the new context is `Gjirokastër County`; `06` stays unchanged and no modern municipality is assigned. If both administrative labels are absent, context is `Albania`, taken only from the required countryInfo metadata. The [official README](https://download.geonames.org/export/dump/readme.txt) also defines admin1 `00` as unspecified; it must not be rewritten to a guessed subdivision.

**Evidence limit:** the historical copy is corroboration, not run #7's retained official bytes. Official search, README and current administrative dictionaries were inspected through web reads, but the four exact files downloaded by run #7 were not available locally. Confirm the precise run snapshot before claiming an exact-file reproduction or worldwide real-data acceptance. A read-only check against retained official inputs is:

```sh
awk -F '\t' '$1=="363341" {print "id=" $1, "country=" $9, "admin1=" $11, "admin2=" $12, "latitude=" $5, "longitude=" $6}' cities500.txt
awk -F '\t' '$1=="AL.45"' admin1CodesASCII.txt
awk -F '\t' '$1=="AL.45.06"' admin2Codes.txt
```

Regression coverage uses temporary, explicitly synthetic/reconstructed official-format TSVs, not modified official source files or production seeds. Parser tests cover missing/blank labels, incomplete codes including `00`, fully qualified joins, complete records, retained identities/coordinates, multiple retained cities, missing country metadata and invalid identities/coordinates. PostgreSQL coverage checks fallback persistence, aliases, untouched codes/coordinates and import provenance. Existing rollback, reconciliation, mapped-country-change, authorization and C6b/C7 tests remain enabled. Import transactions, hashes, settlement filters, schema and GitHub Actions acceptance checks are unchanged. Administrative context remains part of exact locality reconciliation: a less specific context does not authorize automatic matching or registration.

Validation for this correction: full backend suite against disposable PostgreSQL 17 **70 files / 1,541 tests passed, zero skips**; final focused parser/catalog tests **41 passed** (22 parser, 19 PostgreSQL). Typecheck, build and diff whitespace checks passed. Existing pg concurrent-query deprecation warning remains. No production database, source files, workflow or acceptance script was changed; no official worldwide import/reimport acceptance was run here. **STOP for ChatGPT draft PR review; no merge or deployment.**
