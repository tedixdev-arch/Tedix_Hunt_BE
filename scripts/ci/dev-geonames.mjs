// Runs ON the dev API server from its deploy directory (cwd), using that server's own .env.
// Never prints credentials. `check` is read-only; `import` runs a pre-tested GeoNames package once;
// `import-files` streams the four official GeoNames files through the deployed importer (low memory).
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: dev-geonames.mjs check [ignored] [expectedDb] | import import.sql [expectedDb] | import-files <dir> <expectedInputSha256> [expectedDb]';
const [mode, ...args] = process.argv.slice(2);
if (!['check', 'import', 'import-files'].includes(mode)) throw new Error(USAGE);
const [sqlPath, expectedDb = 'tedix_hunt'] = mode === 'import-files' ? [undefined, args[2]] : args;
const [filesDir, expectedInputSha] = mode === 'import-files' ? args : [];
// The importer's own inputs, in the order its fingerprint (manifest.json "sha256") is computed.
const SOURCE_FILES = ['cities500.txt', 'countryInfo.txt', 'admin1CodesASCII.txt', 'admin2Codes.txt'];
if (mode === 'import-files' && (!filesDir || !/^[a-f0-9]{64}$/.test(expectedInputSha ?? ''))) throw new Error(USAGE);
const root = process.cwd() + '/';
const require = createRequire(root);
require('dotenv').config({ path: root + '.env', quiet: true });
if (!process.env.DATABASE_URL) { console.log('FAIL: DATABASE_URL is not set in ' + root + '.env'); process.exit(2); }

const url = new URL(process.env.DATABASE_URL);
console.log(`Config (.env): host=${url.hostname} port=${url.port || 5432} db=${url.pathname.slice(1)} user=${decodeURIComponent(url.username)} password=[hidden]`);

const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const q = async (sql, params) => (await client.query(sql, params)).rows;

const MIGRATIONS = ['032_geographic_catalog', '033_geographic_import_completion', '034_geonames_kosovo_country', '037_geographic_regions', '047_geographic_subregions'];
// Privileges the package needs (SELECT ... FOR UPDATE requires UPDATE).
const REQUIRED = {
  schema_migrations: ['SELECT'],
  countries: ['SELECT', 'INSERT', 'UPDATE'],
  geographic_imports: ['SELECT', 'INSERT', 'UPDATE'],
  geographic_cities: ['SELECT', 'INSERT', 'UPDATE'],
  geographic_city_names: ['SELECT', 'INSERT', 'DELETE'],
  geographic_regions: ['SELECT', 'INSERT', 'UPDATE'],
  geographic_subregions: ['SELECT', 'INSERT', 'UPDATE'],
};

async function regionsViaApiModel() {
  // Same function GET /api/organizer/geography/regions uses; label/status mirror the route.
  const { catalogRegions } = await import(pathToFileURL(root + 'dist/models/OrganizerGeography.js').href);
  const { pool } = await import(pathToFileURL(root + 'dist/lib/postgres.js').href);
  try {
    const rows = (await catalogRegions('RO')).map(c => ({
      regionId: `RO:${c.regionCode === null ? 'unknown' : `admin1:${c.regionCode}`}`,
      label: c.regionCode === null ? 'Unknown region' : c.regionDisplayName ?? c.regionCode,
      labelStatus: c.regionCode === null ? 'unspecified' : c.regionDisplayName === null ? 'missing_label' : 'resolved',
    })).sort((a, b) => (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0));
    const counts = rows.reduce((acc, r) => ({ ...acc, [r.labelStatus]: (acc[r.labelStatus] ?? 0) + 1 }), {});
    console.log('Regions endpoint model (RO): ' + JSON.stringify(counts));
    console.table(rows.slice(0, 20));
    return { rows, counts };
  } finally { await pool.end(); }
}

async function preflight() {
  const [id] = await q(`SELECT current_database() AS database, current_user AS "user", inet_server_addr()::text AS server,
    inet_server_port() AS port, current_setting('server_version') AS version, pg_is_in_recovery() AS replica`);
  console.log('Connected:'); console.table([id]);
  const applied = (await q('SELECT id FROM schema_migrations WHERE id = ANY($1) ORDER BY id', [MIGRATIONS])).map(r => r.id);
  console.log('Geographic migrations applied: ' + applied.join(', '));
  const privileges = [];
  for (const [table, needed] of Object.entries(REQUIRED)) {
    const row = { table };
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) row[p] = (await q('SELECT has_table_privilege($1, $2) AS ok', [table, p]))[0].ok;
    row.required = needed.join(','); row.ok = needed.every(p => row[p]);
    privileges.push(row);
  }
  console.log('Table privileges for current user:'); console.table(privileges);
  const [state] = await q(`SELECT (SELECT count(*) FROM geographic_regions WHERE country_code='RO')::int AS ro_regions,
    (SELECT count(*) FROM geographic_cities WHERE country_code='RO')::int AS ro_cities,
    (SELECT count(DISTINCT admin1_code) FROM geographic_cities WHERE country_code='RO' AND admin1_code NOT IN ('','00'))::int AS ro_region_codes_in_use,
    (SELECT count(*) FROM geographic_imports)::int AS imports`);
  console.log('Current catalog state:'); console.table([state]);
  console.table(await q('SELECT dataset, row_count, completed_at FROM geographic_imports ORDER BY imported_at DESC LIMIT 3'));
  const problems = [];
  if (id.database !== expectedDb) problems.push(`database is ${id.database}, expected ${expectedDb}`);
  if (id.replica) problems.push('connected to a read-only replica');
  if (applied.length !== MIGRATIONS.length) problems.push('missing migration(s): ' + MIGRATIONS.filter(m => !applied.includes(m)).join(', '));
  for (const p of privileges) if (!p.ok) problems.push(`missing ${p.required} on ${p.table}`);
  console.log(problems.length ? 'PREFLIGHT: NOT READY — ' + problems.join('; ') : 'PREFLIGHT: READY for import');
  return problems;
}

try {
  if (mode === 'check') {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    await preflight();
    await regionsViaApiModel();
  } else {
    const problems = await preflight();
    if (problems.length) { console.log('ABORTED: preflight failed; nothing executed.'); process.exitCode = 3; }
    else {
      // Existing Localities and city-to-Locality links (e.g. canonical Cluj-Napoca) must survive unchanged.
      const snapshot = async () => (await q(`SELECT (SELECT count(*) FROM localities)::int AS localities,
        (SELECT md5(coalesce(string_agg(geoname_id || ':' || locality_id, ',' ORDER BY geoname_id), '')) FROM geographic_cities WHERE locality_id IS NOT NULL) AS links,
        (SELECT count(*) FROM geographic_cities WHERE locality_id IS NOT NULL)::int AS linked_cities,
        (SELECT count(*) FROM geographic_cities WHERE country_code='RO')::int AS ro_cities`))[0];
      // One transaction: commit only if every preservation condition holds; any error or failed check rolls back.
      const preserved = async (work) => {
        const started = Date.now();
        await client.query('BEGIN');
        try {
          const before = await snapshot();
          await work();
          const after = await snapshot();
          console.log('Preservation check (before → after):'); console.table([before, after]);
          if (after.localities !== before.localities || after.links !== before.links || after.ro_cities < before.ro_cities) {
            await client.query('ROLLBACK');
            console.log('ABORTED: existing Localities or city links would change; rolled back, nothing imported.'); process.exitCode = 5;
            return;
          }
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          console.log('ABORTED: import failed and was rolled back; nothing imported. ' + (error?.message ?? error)); process.exitCode = 1;
          return;
        }
        await client.query('COMMIT');
        console.log(`IMPORT: committed in ${Date.now() - started} ms`);
        console.table(await q(`SELECT (SELECT count(*) FROM countries)::int AS countries,
          (SELECT count(DISTINCT country_code) FROM geographic_cities)::int AS countries_with_cities,
          (SELECT count(*) FROM geographic_regions)::int AS regions, (SELECT count(*) FROM geographic_subregions)::int AS subregions,
          (SELECT count(*) FROM geographic_cities)::int AS cities`));
      };
      if (mode === 'import') {
        const sql = readFileSync(sqlPath, 'utf8');
        await preserved(() => client.query(sql)); // One atomic DO statement from the tested importer.
      } else {
        // Low-memory path: the deployed importer streams cities500.txt line by line in batches of 500.
        const files = SOURCE_FILES.map(name => join(filesDir, name));
        const missing = files.filter(file => !existsSync(file));
        const { hashGeonames, importCities, readGeonames } = await import(pathToFileURL(root + 'dist/scripts/importGeonames.js').href);
        const actual = missing.length ? null : await hashGeonames(files);
        if (missing.length) { console.log('ABORTED: missing source file(s): ' + missing.join(', ') + '; nothing executed.'); process.exitCode = 6; }
        else if (actual !== expectedInputSha) {
          console.log(`ABORTED: input fingerprint ${actual} does not match the expected ${expectedInputSha}; nothing executed.`); process.exitCode = 6;
        } else {
          console.log(`Input fingerprint matches the tested package: ${actual}`);
          await preserved(async () => {
            const result = await importCities(client, readGeonames(...files), { dataset: 'GeoNames cities500 + countryInfo + admin1CodesASCII + admin2Codes', sha256: actual });
            console.log(`Importer accepted ${result.rows} cities (import ${result.importId}).`);
          });
        }
      }
    }
    if (process.exitCode === undefined) {
      const regions = await q("SELECT admin1_code, display_name FROM geographic_regions WHERE country_code='RO' ORDER BY admin1_code");
      console.log(`geographic_regions RO rows: ${regions.length}`); console.table(regions);
      console.table(await q('SELECT dataset, row_count, completed_at FROM geographic_imports ORDER BY imported_at DESC LIMIT 1'));
      const { counts } = await regionsViaApiModel();
      if (counts.missing_label) { console.log('VERIFY: FAIL — some regions still missing labels'); process.exitCode = 4; }
      else console.log('VERIFY: PASS — every RO region resolves to a name');
    }
  }
} finally {
  await client.end();
}
