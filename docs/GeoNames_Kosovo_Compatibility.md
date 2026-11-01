# GeoNames Kosovo compatibility

The GeoNames import failed with SQLSTATE 23514 at `countries_code_check` when inserting `(XK, Kosovo)`. Migration 024 defines this PostgreSQL check as the explicit 249 assigned ISO 3166-1 alpha-2 codes. GeoNames uses `XK` for Kosovo; it is not in that assigned ISO list. The importer already retains `XK` correctly, but the country insert fails before the city batch can commit.

Forward-only migration **034_geonames_kosovo_country** replaces only that check, atomically through the existing migration runner, with the original 249 codes plus the explicit `XK` exception. Fresh `schema.sql` has the identical rule. Historical migrations stay unchanged. No country rows are seeded, renamed or removed. The official importer supplies Kosovo's country name from countryInfo and inserts it normally. No codes are remapped and no cities are skipped. Applying the migration takes the normal PostgreSQL ALTER TABLE lock and validates existing rows; it does not run an import.

## Contract review

- Backend country and locality DTOs use string codes. Geography routes, proposals, Organizer selection, Template snapshot validation and SQL snapshot checks require uppercase two-letter syntax; live selection also checks database membership. These already admit `XK` while preserving unknown-country rejection.
- `Geography.countries()` returns the stored country reference; city search and registered-locality search require that reference. Kosovo becomes available after a successful committed import containing its cities, just like other imported countries. Catalog readiness remains a separate contract.
- `GeographicCatalog` scopes aliases, candidates and exact matches by the original country code. Admin registration, UUID reuse, mapped-country-change protection and independent Template approval remain unchanged. Existing localities, Template versions, Hunts and frozen snapshots are never rewritten by this migration.
- Reviewed frontend `Tedix_Hunt_FE` main: `src/services/api/geography.ts`, `src/features/creator/LocalGeographySelector.tsx`, `src/services/api/localityProposals.ts` and `src/components/OrganizerHuntGeography.tsx`. Country codes and snapshots are strings; selector options come from the backend, searches pass the selected code unchanged, and result filtering compares that code exactly. No FE ISO allowlist or FE change is required in these contracts. Backend OpenAPI two-letter patterns already include XK.

## Regression coverage

The pre-034 database rejects XK at the exact named constraint. Upgrade and repeat-run checks preserve countries, an existing locality, Template/review/Hunt history and snapshots. Fresh/upgraded country constraints and indexes are compared. All 676 uppercase two-letter combinations are exercised: exactly the original 249 ISO codes plus XK succeed; other combinations and malformed/lowercase/whitespace codes fail.

Synthetic official-format parser tests retain XK, RO, US and DE unchanged. PostgreSQL/API tests import a Kosovo city, list Kosovo, search its alias under XK, register it with Admin authority, resolve the same locality UUID after reimport, and search the registered locality. Invalid codes still fail import and API validation. Existing country-move, reconciliation and approval tests remain enabled. No official GeoNames file, Actions workflow or acceptance script is changed.

Validation against disposable PostgreSQL 17: full backend suite **70 files / 1,547 tests passed, zero failures or skips**. Typecheck, build and `git diff --check` passed. The full migration discovery test applies all 34 migrations and verifies a repeat applies zero. The existing pg concurrent-query deprecation warning remains. GitHub Actions, acceptance scripts and migration 024 were checked unchanged against main `01cedb1374066969924fc8523e5b203c35525ef8`. Official worldwide import acceptance is intentionally not run here. No production import, deployment or merge. **STOP for ChatGPT review.**
