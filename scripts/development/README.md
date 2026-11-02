Temporary Cluj setup through pgAdmin Web
========================================

Use the owner's independently verified **tedixhunt_dev** PostgreSQL connection. The real database is **tedix_hunt**, and the login/current role is **tedix_app**. Names alone do not identify the server: compare the PostgreSQL server address/port with the owner's previously reviewed independent development evidence (`DEV_PG_SERVER_ADDR` / `DEV_PG_SERVER_PORT` in the existing binding process). Do not obtain replacement target values from an unverified connection. A shared/loopback address is not a unique cluster identity; the independently verified pgAdmin development connection remains required. Never select a production connection.

No server shell, SSH, GeoNames import, new workflow or backend runtime change is needed. The script never runs on startup, migration or deployment. It does not approve localities or Templates, change permissions, update drafts or relax eligibility/version rules.

After ChatGPT review, the owner can perform these steps (not executed by this PR):

1. In pgAdmin Web select **tedixhunt_dev → Databases → tedix_hunt → Tools → Query Tool**, using **tedix_app** directly (no SET ROLE). Run these read-only checks and compare the endpoint with the independently reviewed development values:

   ```sql
   SELECT current_database(), current_user, session_user,
          inet_server_addr()::text AS server_address, inet_server_port() AS server_port;
   SELECT id, country_code, name, administrative_context, latitude, longitude, active, provider
   FROM public.localities
   WHERE country_code = 'RO'
     AND lower(regexp_replace(name, '[[:space:]-]', '', 'g')) = 'clujnapoca'
   ORDER BY id;
   SELECT has_table_privilege(current_user, 'public.localities', 'SELECT') AS can_read,
          has_table_privilege(current_user, 'public.localities', 'INSERT') AS can_insert,
          has_table_privilege(current_user, 'public.localities', 'UPDATE') AS can_update;
   ```

   One active candidate is reused, regardless of its existing Cluj administrative label or coordinates. Keep its UUID and provenance. Do not insert a replacement or edit saved snapshots. Multiple active matches or only inactive matches require normal Admin reconciliation; do not reactivate or approve anything with this seed. Missing privileges are a real permission issue: stop rather than grant rights or use a broader role here.

2. Open/download **scripts/development/cluj-locality.sql** from this PR. In Query Tool Open File/upload it (or paste the small SQL file). Set only `expected_server_address` and `expected_server_port` to the independently reviewed **PostgreSQL** endpoint, not the HTTPS API address. Leave `action = 'apply'`. The file deliberately refuses unchanged placeholders, the wrong endpoint, any database other than `tedix_hunt`, or either login/current role other than `tedix_app`.
3. Execute the **whole DO statement**. It is atomic; no psql meta-commands, extensions, temporary schema, superuser functions or shell access are required. pgAdmin's Messages tab reports the reused or created UUID. A single active matching reference causes no write. If none exists (including no stale seed-owned identity), it inserts one manual development reference with a database-generated UUID and explicit provenance. It creates no country, GeoNames/catalog/import, approval or Template record. A 5-second lock timeout bounds contention; on an error no partial seed is committed. If the Query Tool has an explicit transaction already open, rollback on failure; otherwise commit only after the successful result has been reviewed.
4. Repeat the SELECT above: exactly one active selectable Cluj locality should exist. Re-executing the script does not change that row, its timestamps or provenance. No API/server restart is needed; the normal registry API reads this table.
5. Follow FE PR #143's **docs/development-cluj-setup.md** for the normal development deployment and Creator/Organizer checks. The registered locality enables geography selection only; Organizer still needs an actually eligible approved Template through the existing exact-version workflow.

Reversal: use the same reviewed endpoint constants and change only `action` to `remove`. Execute the whole statement. It idempotently deactivates only the `development-setup` / `cluj-napoca` record, preserving UUIDs, foreign keys, version snapshots and history. Reused registry-owned records are never changed. Subsequent apply never silently reactivates an inactive record. Before retiring a referenced development record, use normal catalog reconciliation to preserve its UUID, or retain it while drafts still need it.

Verification
------------

`src/db/developmentClujSeed.integration.test.ts` executes this exact SQL in disposable PostgreSQL 17, after all real migrations, using a non-superuser `tedix_app` role with only schema USAGE, country/locality SELECT, locality INSERT/UPDATE and no schema CREATE. It tests insert, repeat, existing-reference reuse, inactive/ambiguous refusal, endpoint/database/role guards, missing-country rollback, concurrent apply and removal with a real saved Template version reference/snapshot. The full existing BE suite remains required.

Run in the existing disposable CI PostgreSQL service with `TEST_DATABASE_URL` set to its local `tedix_test` database: `npm run build` then `npm test`. This suite creates and drops its own `tedix_hunt` test database/template and test role, and refuses nonlocal/non-test bootstrap URLs. Never supply a persistent database URL to tests. No persistent database or deployed service was modified to prepare this PR.
