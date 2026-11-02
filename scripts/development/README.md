Temporary Cluj setup
===================

This opt-in command adds a real manual registry reference for development Creator setup when no Cluj locality exists. It does not import GeoNames, approve a locality or Template, or make a Template eligible for Organizer use. Existing authorization, submission and exact-version eligibility checks still apply.

After normal migrations, in a dedicated development database whose name ends in `_dev`:

```sh
NODE_ENV=development DEVELOPMENT_LOCALITY_SEED=cluj DEVELOPMENT_DATABASE_URL='<development PostgreSQL URL>' node scripts/development/cluj-locality.mjs apply
```

The command deliberately ignores `DATABASE_URL`. It is never run by startup, migrations or deployment. Do not point it at a production database. No database has been changed by this PR.

Repeated application is a no-op. An existing unambiguous active Cluj reference is retained; ambiguous or inactive records require explicit Admin reconciliation. Only a new record gets the `development-setup` provenance. Country RO must already exist from normal migrations. Coordinates approximate the city centre, not a verified checkpoint or safe route.

To reverse the seed, use the same explicit environment with the `remove` action. This idempotently deactivates only the seed-owned record; it preserves UUIDs, saved snapshots, foreign keys and unrelated registry entries. Reapplication never silently reactivates an inactive record. If referenced drafts still need the locality, reconcile the catalog to that UUID before retiring it.

Frontend pairing: the FE development-mode `.env.development` enables `VITE_DEVELOPMENT_LOCATION_PRESET=cluj`. Run `npm run dev`, or build a development artifact with `npm run build -- --mode development`. Ordinary production mode ignores the flag. Removing the preset restores the catalog selector without changing the form. Organizer geographic fields remain geographic text fields; they never supply a locality UUID or substitute for eligible approved Template selection.

Tests: `node scripts/development/cluj-locality.test.mjs` (five safety/transaction unit tests). These tests inject the database client; they do not validate a live PostgreSQL instance. The command has not been executed against any remote database.
