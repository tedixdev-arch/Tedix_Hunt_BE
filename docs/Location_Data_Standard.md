# Location data standard and workflows

This standard applies to every country the app supports. It builds on `Geographic_Catalog.md` (GeoNames import, city resolve API) and `F7_C6b_3_Manual_Locality_Proposals.md` (manual proposals). It changes neither of those workflows' authority rules.

## 1. One shape for every country: Country → Region → City

| Level | Source of truth | Identity | Label shown to users |
| --- | --- | --- | --- |
| Country | `countries` (ISO 3166-1 alpha-2, filled by the GeoNames import) | `code` | `display_name` |
| Region | GeoNames first-level division (admin1), `geographic_regions` | `country_code` + `admin1_code` | Official admin1 name. Code-only fallback `Region <code>` when the official dictionary has no name. |
| City | GeoNames populated place (`geographic_cities`), or a manual Locality from an approved proposal | GeoNames ID, or Locality UUID for a manual Locality | City name; administrative context as secondary text |

Rules:

- **The region level is always admin1.** Its name per country comes from `domain/geographicRegions.ts` (`regionLabel`): County (RO, HU), District (MD, XK), State (US, AU, BR, DE, AT, IN, MX), Province (CA, NL), Canton (CH), Voivodeship (PL), Region (FR, IT and the default), Autonomous community (ES). To name another country's level, add it there, and only if GeoNames admin1 really is that level for the country.
- **Nothing is hidden.** Cities whose admin1 is blank or `00`, and manual Localities without a region, are grouped under the explicit region `unspecified`, labelled "Other (region not specified)" and listed last. Regions without an official name are still selectable and are shown as `Region <code>`.
- **`labelStatus`** on each region (`resolved`, `missing_label`, `unspecified`) lets clients that need an official region skip the other two. Content Library region scope is one: its foreign key requires an official region.
- **Dropdown order** is alphabetical by name (diacritic-insensitive), done by the client; the API pages in stable GeoNames-ID order.
- **Every listed city is usable. No Admin registration.** Selecting a GeoNames city (`POST /api/geography/cities/{id}/resolve`, Creator or Admin) links it to its own GeoNames Locality or to the single exact same-place Locality, otherwise creates a new Locality. The automatic creation is audited (`reconciled_by`, `reconciliation_reason`, `provenance`). A manual Locality is usable once its proposal is approved. Only a Locality switched off in the registry (`active = false`, a database operation) is unavailable.

## 2. Listed cities and missing places

| Situation | What happens | Who acts |
| --- | --- | --- |
| City is in the GeoNames list | Chosen directly from the City dropdown. Its Locality is linked or created automatically on first selection by a Creator. No warning, request or Admin step. | Creator or Organizer |
| Place is **missing** from the GeoNames list | **Locality proposal**: Creator submits it with evidence, and a different Admin approves or rejects it | Creator submits; Admin decides in Admin → Locations |

The former Admin City registration (`POST /api/geography/cities/{id}/registration` and its screen) was removed at the client's request. Organizers can choose any city. A city with no Locality yet simply has no approved Local Hunts.

Server-enforced separation (migration 046):

- A proposal carries the county/region it belongs to (`admin1Code`). The region is required whenever the country has official regions; otherwise the API returns `400 region_required`.
- A proposal whose name (normalized; case, spacing and punctuation ignored) matches a GeoNames city or alias in the same region is refused with `409 catalog_city_exists`. Without a region, the match is checked across the whole country. The check runs again at approval, so a city imported after submission cannot be duplicated.
- Approval copies the region onto the new Locality (`localities.admin1_code`). The Locality then appears in that region's City list for Creators and Organizers (`registryLocalities` in `/api/geography/cities`; `source: 'registry'` entries in the Organizer city list).
- An automatically created Locality records the city's region too. A linked Locality's region always comes from its catalog city.

## 3. API summary (additive)

- `GET /api/geography/regions`: includes code-only and `unspecified` regions; each entry has `labelStatus`; `regionLabel` follows the per-country standard.
- `GET /api/geography/cities?countryCode&admin1Code`: **without `q`**, lists every city of the region (dropdowns), paged by `after`. `admin1Code=unspecified` selects the unspecified group. The first page also returns `registryLocalities`: manual Localities of that region, in the same shape with `geographicId: null`. With `q`, the existing prefix search is unchanged.
- `GET /api/geography/localities/{id}` and `/localities?q`: add `geographicId` (linked city or null), `admin1Code` and `regionDisplayName`. Template locality snapshots are unchanged.
- `GET /api/organizer/geography/regions`: each region has `levelLabel` and the standard labels. `/cities` adds `registeredActive` and lists active manual Localities (`source: 'registry'`, `geographicId: null`).
- `POST /api/geography/cities/{id}/resolve`: links or creates the city's Locality and returns the city (`registrationState` is `registered`, or `registered_inactive` for a switched-off Locality). Unlinked cities in lists report `registrationState: not_linked` and `nextAction: resolve_city`; they are usable.
- `POST /api/geography/locality-proposals`: optional `admin1Code` (required when the country has regions); errors `region_required` and `catalog_city_exists`.

## 4. Adding or refreshing location data for a country

1. **Import the catalog.** Run the GeoNames import (`GeoNames_Actions.md`, `GeoNames_pgAdmin_Import.md`). It adds the country, its admin1 regions with official names, and its cities with aliases. Never type cities or regions by hand; the import is the only writer of `countries`, `geographic_regions` and `geographic_cities`.
2. **Check the region level name.** If GeoNames admin1 for the country has a common name (State, Province, …), add it to `regionLabel` in `domain/geographicRegions.ts`; otherwise users see "Region". `metadataStatus: incomplete` means some cities use admin1 codes without official names; they stay selectable by code.
3. **Nothing to register.** Every imported city can be chosen immediately.
4. **Missing places come only from proposals.** Creators propose them from the "Can't find your locality?" panel, with evidence, filed under a region. Admins approve them in Locality proposals after checking the "Already in the GeoNames city list" warning.
5. **Never edit Locality rows directly** to rename or move a place. Locality identity and Template snapshots depend on them; corrections need a separately reviewed maintenance step.

## 5. Known limits

- The catalog is GeoNames `cities500` (places above about 500 inhabitants and administrative seats). Smaller villages are added through proposals.
- No API changes a Locality's `active` flag. Deactivation is still a database operation.
- Content Library city scope matches only GeoNames cities. A Template on a manual Locality can use Universal, Country and (when the Locality has a region) Region content.
- Existing manual Localities approved before migration 046 have no region and appear under "Other (region not specified)".
