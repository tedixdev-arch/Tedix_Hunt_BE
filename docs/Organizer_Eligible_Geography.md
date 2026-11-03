# Organizer eligible geography

Authenticated bearer access token and persisted active, non-guest Organizer capability required (Admin alone is insufficient). All responses use `Cache-Control: private, no-store`. Dedicated per-account geography budget: 120 requests/minute, plus existing application abuse protection. Budget exhaustion returns 429 `rate_limited` with `Retry-After` seconds.

## FE flow and URLs

1. `GET /api/organizer/geography/countries?limit=20`
2. `GET /api/organizer/geography/regions?countryCode=RO&limit=20`
3. `GET /api/organizer/geography/cities?countryCode=RO&regionId=RO%3Aadmin1%3A13&limit=20`
4. Pass the returned canonical `localityId` and `countryCode` into existing `GET /api/organizer/local-templates?countryCode=RO&localityId=<uuid>`.

Existing exact-version preview `GET /api/organizer/local-templates/<templateId>/versions/<version>?countryCode=RO&localityId=<uuid>` and selection `PUT /api/hunts/<huntId>/local-template` remain unchanged. Selection body remains `{templateId,version,countryCode,localityId}`. Inventory is advisory: refresh and explicitly reselect on stale eligibility conflicts.

## Response fields

Every new endpoint returns its named array (`countries`, `regions`, or `cities`) and `nextCursor` (opaque string or null). Append URL-encoded `cursor=<nextCursor>` for the next page. `limit` is 1–50, default 20. Cursors bind endpoint, country and region; reset on any filter change. Order is ascending lexical stable identifier, independent of labels. Live inventory changes between requests are possible.

- Country: `countryCode` (ISO code), `displayName`.
- Region: `regionId` (opaque, country-scoped stable identifier), `countryCode`, `regionCode` (GeoNames admin1 code or null), `label`, `labelStatus` (`resolved`, `missing_label`, `unspecified`), `level` (`admin1`). Admin1 means County in Romania and State / Region elsewhere.
- City: `geographicId` (stable GeoNames ID string), `localityId` (canonical UUID for C7), `countryCode`, `countryDisplayName`, `name`, `administrativeContext`, `regionId`, `regionCode` (nullable), `regionDisplayName` (nullable authoritative dictionary label), `source` (`geonames`), `attribution` (`GeoNames (CC BY 4.0)`). Never pass geographicId as localityId.

Region labels come exclusively from the existing `geographic_regions` dictionary. A missing label uses the code as `label` with `missing_label`; empty or `00` admin1 uses `regionCode:null`, `regionId:"RO:unknown"` (country-scoped), `label:"Unknown region"`, `labelStatus:"unspecified"`. The bucket is selectable like any region. Administrative context and city names are never parsed to guess County.

## Eligibility and empty results

One database statement joins the exact C7 authority query to `geographic_cities` through canonical locality UUID and matching country, with an optional authoritative region-label join. Every candidate is evaluated by the existing `resolveLocalArtifact` before deduplication, grouping, cursor filtering and pagination. No duplicated eligibility rules or pre-validation LIMIT. Suspended, invalid authority/content, unapproved, inactive and changed/wrong locality artifacts are excluded by C7. Only explicitly mapped catalog cities appear; no name matching, implicit registration or provider calls. Eligible localities absent from the catalog mapping cannot appear in this catalog-based flow.

Empty inventory (including no imported/mapped catalog records, unknown well-formed country/region, or no eligible artifacts) returns 200 with an empty array and null cursor. Malformed, extra or repeated query fields and cross-scope cursors return 400 `invalid_input`; missing/invalid/inactive-account authentication returns 401; missing Organizer capability or guest returns 403. No private review/content fields are exposed.

No migration, Creator/legacy behavior, approval semantics, or deployment changes. All candidate artifacts for the selected country (all countries for the first step) are loaded to run the shared application resolver correctly before pagination; this follows existing C7 discovery's approach and may require future optimization for large inventories.
