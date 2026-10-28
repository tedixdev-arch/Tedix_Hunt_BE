# F7/C6b-1 — Minimal Country/Locality foundation

Based on freshly fetched main `9ca8d90` (merged PR #81), with C1–C5 and the merged C6a contract present. This implementation is limited to the user-authorized C6b-1 slice. The C6a recommendation about withdrawing approved Local Templates during revision is not implemented. Approved Local revision and selection policy remain later work.

Migration **024_country_locality** adds only `countries` and `localities`; the fresh schema mirrors it. Existing tables, strings, Signal content, Template versions/reviews/publication pointers and Hunt snapshots are untouched. Migration history tests include 024. Roll forward; no destructive down migration.

The initial country reference is deliberately **RO / Romania**, using the established Signal country and its ISO 3166-1 alpha-2 identity ([ISO reference](https://www.iso.org/iso-3166-country-codes.html)). A static check restricts country codes to assigned ISO alpha-2 codes; this is not a synchronized global reference feed. Additional country names require a reviewed reference update. No locality is seeded or imported, including Cluj-Napoca.

Localities have stable UUIDs, restrictive country FK, bounded nonblank name/context/provenance, finite bounded representative coordinates, active flag, timestamps and optional paired provider identity with compound uniqueness. Same-name settlements and coincident coordinates are allowed. Indexes support country filtering and deterministic active-name ordering. Substring matching can scan the selected country's rows; no geographic or fuzzy-search engine is introduced. There is no catalog write API in this slice. Future correction workflows must maintain `updated_at`, record the Admin correction evidence, preserve place identity and verify storage rights before activating provider persistence.

## Read API

All routes require existing persisted active non-guest Creator, Organizer or Admin capability. Participant-only, guests, blocked/retired accounts and revoked roles cannot read. Authentication and role checks precede validation and lookup; JWT role claims are not authority.

- `GET /api/geography/countries` returns `{ "countries": [{ "code": "RO", "displayName": "Romania" }] }`.
- `GET /api/geography/localities?countryCode=RO&q=Cluj` returns `{ "localities": [], "providerStatus": "not_requested" }` on the initially empty catalog. Country is required, uppercase and must exist in the reference. Query is nonblank and at most 100 characters. Literal case-insensitive name substring matching returns at most 50 active records, ordered by name/context/UUID. Same-name identities remain separate. Unknown/extra query parameters, including `includeProvider`, return 400 `invalid_input`.
- `GET /api/geography/localities/{id}` returns the exact current catalog record, including an inactive record. Invalid UUID is 400 `invalid_input`; absent UUID is 404 `not_found`. No similarity fallback or external dependency.

Catalog records expose only `id`, `countryCode`, `countryDisplayName`, `name`, `administrativeContext`, `latitude`, `longitude`, `active`. Internal provider identity and provenance are excluded. There are no external calls, provider candidate persistence, proposal writes, Template locality bindings, Local revisions or classified Organizer selection changes.

## Verification

Final full regression: **55 files / 1,043 tests passed, zero skips**. `npm run typecheck`, `npm run build` and `git diff --check` passed. Focused migration/API checks also passed (30 tests across the new geography suite and migration suite). Dedicated PostgreSQL 17 container on local port 5546; no live database or deployment. New integration coverage checks pre-024 upgrade and rerun, unchanged Signal/classified version/review/Hunt history, fresh-schema constraint/index parity, actual model queries and HTTP reads, inactive resolution, literal LIKE escaping, input bounds, ISO/FK/coordinate/provenance/provider constraints and persisted authorization. Existing regression suites retain their historical compatibility checks.
