# Organizer location discovery verification

Base: upstream main 1791e1cc60043a3bf14ec7ea3c98e0e00b7c8a1c.

The existing Organizer geography query required C7-approved mapped Local artifacts,
which hid Romania / Cluj / Cluj-Napoca when there were no eligible Local Hunts.
Location discovery now reads the existing countries, geographic_regions and
geographic_cities catalog. Creator discovery uses those same references. The
existing Organizer endpoints, field names, region identity, country/region-scoped
cursors, limits, authentication, private caching and request budget are retained.
Unregistered cities have a null localityId, as in the Creator catalog; registration
and approval authority remain unchanged. Existing locality UUIDs are reused.

C7 Local Hunt listing, preview and selection retain their exact-version approval,
suspension, authority, active-locality and geography checks. No changes were made
to OrganizerLocalTemplate or its routes. No FE, endpoint, migration, deployment,
seed application or saved-data modification is included.

## Exact observed API responses

[Organizer_Location_Discovery_Responses.json](Organizer_Location_Discovery_Responses.json)
contains all seven exact HTTP status/body pairs from authenticated Supertest API
requests on disposable PostgreSQL 17, using the real app, all 37 migrations and
the existing curated development seed. It includes both roles' discovery and an
empty C7 Local Hunt list. Zero approved Local Templates existed. The recorded UUID
is generated in that disposable database, **not the deployed canonical UUID**.

Observed identifiers: Romania RO; Cluj admin1 13 / Organizer regionId
RO:admin1:13; Cluj-Napoca geographicId 681290. Creator and Organizer returned the
same canonical locality UUID in the recorded run. All seven responses were 200.
Organizer countries/regions/cities were nonempty while Local Hunt discovery was
exactly `{ "templates": [], "nextCursor": null }`.

## Development database / deployment blockers

The **deployed development database is unverified**. This managed environment has
no DATABASE_URL, development database credential/identity binding, or SSH credential
configured, and no private database network grant. No deployed API token was
available. No live development API response or successful seed/deployment is claimed.
The disposable test database is not evidence about deployed development inventory.

The existing `seed:development:cluj` command, merged in PR #116, is opt-in and is
not run by normal startup, migration or deployment. The older
`scripts/development/cluj-locality.sql` seeds only a locality; it does not provide
the county/city catalog. If required rows are missing after normal migrations,
the existing development seed is the missing data setup step. On the independently
verified development connection, an authorized operator can run:

```sh
NODE_ENV=development npm run seed:development:cluj
```

Do not apply it to production. Ambiguous, inactive or conflicting canonical rows
require existing Admin reconciliation; do not create a replacement UUID. The code
change alone cannot repair missing geographic data. Neither the seed nor a backend
deployment was executed as part of this work.

On that verified development connection, these read-only queries establish the
required data and existing canonical mapping (do not substitute returned connection
identity for independent target verification):

```sql
BEGIN READ ONLY;
SELECT current_database(), current_user, inet_server_addr(), inet_server_port();
SELECT code, display_name FROM countries WHERE code='RO';
SELECT country_code, admin1_code, display_name FROM geographic_regions
WHERE country_code='RO' AND admin1_code='13';
SELECT g.geoname_id, g.country_code, g.admin1_code, g.name, g.locality_id,
       l.country_code AS locality_country, l.name AS locality_name, l.active,
       i.completed_at, i.row_count
FROM geographic_cities g LEFT JOIN localities l ON l.id=g.locality_id
JOIN geographic_imports i ON i.id=g.import_id WHERE g.geoname_id=681290;
SELECT normalized_name FROM geographic_city_names WHERE geoname_id=681290;
ROLLBACK;
```

Expected: RO/Romania, RO+13/Cluj, 681290/RO/13/Cluj-Napoca, matching active canonical
locality UUID, nonempty completed import and searchable names. Missing dictionary
labels or incomplete imports remain data/import blockers. Retain live API responses
after a separately authorized deployment to close the verification gap.

## Validation

Complete BE suite with disposable PostgreSQL 17: 76 files / 1,681 tests passed,
zero skipped and zero unhandled errors. After adding one further catalog-only
regression case, the seed integration suite passed all eight tests.
`npm run typecheck`, `npm run build`, and `git diff --check` passed.

Coverage includes zero-approved-Local discovery with exact responses, no writes
during discovery, unregistered-city parity, countries without cities, counties
without cities, canonical UUID reuse, suspension-independent location visibility,
C7 rejection/listing/selection, country isolation, pagination, missing metadata,
authentication and role guards, rate limits, and existing saved-data regressions.
