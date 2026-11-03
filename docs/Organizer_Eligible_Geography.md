# Organizer geographic catalog discovery

Authenticated bearer access token and persisted active, non-guest Organizer capability required (Admin alone is insufficient). All responses use `Cache-Control: private, no-store`. Dedicated per-account geography budget: 120 requests/minute, plus existing application abuse protection. Budget exhaustion returns 429 `rate_limited` with `Retry-After` seconds.

## Existing flow and URLs

1. `GET /api/organizer/geography/countries?limit=20`
2. `GET /api/organizer/geography/regions?countryCode=RO&limit=20`
3. `GET /api/organizer/geography/cities?countryCode=RO&regionId=RO%3Aadmin1%3A13&limit=20`
4. For a city with a canonical `localityId`, pass that UUID and `countryCode` into existing `GET /api/organizer/local-templates?countryCode=RO&localityId=<uuid>`.

Countries, regions and cities use the same stored countries, geographic_regions and geographic_cities catalog as Creator discovery. They are independent of approved Local Hunt availability. No approval query or C7 resolver runs during location discovery. A country or county may be selected even when it has no approved Local Hunts.

Existing exact-version preview `GET /api/organizer/local-templates/<templateId>/versions/<version>?countryCode=RO&localityId=<uuid>` and selection `PUT /api/hunts/<huntId>/local-template` remain unchanged and retain all C7 eligibility checks. Selection body remains `{templateId,version,countryCode,localityId}`. Refresh and explicitly reselect on stale eligibility conflicts.

## Response fields

Every endpoint returns its named array (`countries`, `regions`, or `cities`) and `nextCursor` (opaque string or null). Append URL-encoded `cursor=<nextCursor>` for the next page. `limit` is 1–50, default 20. Cursors bind endpoint, country and region; reset on any filter change. Order is ascending lexical stable identifier, independent of labels. Catalog changes between requests are possible.

- Country: `countryCode` (ISO code), `displayName`. Includes stored countries even without city rows.
- Region: `regionId` (opaque, country-scoped stable identifier), `countryCode`, `regionCode` (GeoNames admin1 code or null), `label`, `labelStatus` (`resolved`, `missing_label`, `unspecified`), `level` (`admin1`). Admin1 means County in Romania and State / Region elsewhere. Includes stored dictionary regions even without city rows, plus explicit buckets for city codes missing metadata.
- City: `geographicId` (stable GeoNames ID string), `localityId` (canonical UUID or null when not registered or mapping has the wrong country), `countryCode`, `countryDisplayName`, `name`, `administrativeContext`, `regionId`, `regionCode` (nullable), `regionDisplayName` (nullable authoritative dictionary label), `source` (`geonames`), `attribution` (`GeoNames (CC BY 4.0)`). Never pass geographicId as localityId. An unregistered city remains discoverable; Admin registration/reconciliation is still required before C7 use. Inactive registrations remain discoverable as in the Creator catalog; C7 rejects their use.

Region labels come exclusively from the existing `geographic_regions` dictionary. A missing label uses the code as `label` with `missing_label`; empty or `00` admin1 uses `regionCode:null`, `regionId:"RO:unknown"` (country-scoped), `label:"Unknown region"`, `labelStatus:"unspecified"`. Administrative context and city names are never parsed to guess County.

## Empty results and errors

No stored matching catalog records, including an unknown well-formed country/region, returns 200 with an empty array and null cursor. No approved Local Hunts does not empty the location arrays. Malformed, extra or repeated query fields and cross-scope cursors return 400 `invalid_input`; missing/invalid/inactive-account authentication returns 401; missing Organizer capability or guest returns 403. No private review/content fields are exposed.

This change introduces no endpoint, migration, FE change or approval rule. The existing cursor adapter groups catalog references before pagination. Missing catalog data must be supplied through the existing import or development seed, not approval fabrication. See Development_Cluj_Geography.md and Organizer_Location_Discovery_Verification.md.
