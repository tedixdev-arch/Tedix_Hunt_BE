// Runs ON the dev API server from its deploy directory (cwd), using that server's own .env.
// Never prints credentials. `check` is read-only; `import` runs a pre-tested GeoNames package once.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [mode, sqlPath, expectedDb = 'tedix_hunt'] = process.argv.slice(2);
if (!['check', 'import'].includes(mode)) throw new Error('Usage: dev-geonames.mjs check|import [import.sql] [expectedDb]');
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

const MIGRATIONS = ['032_geographic_catalog', '033_geographic_import_completion', '034_geonames_kosovo_country', '037_geographic_regions'];
// Privileges the package needs (SELECT ... FOR UPDATE requires UPDATE).
const REQUIRED = {
  schema_migrations: ['SELECT'],
  countries: ['SELECT', 'INSERT', 'UPDATE'],
  geographic_imports: ['SELECT', 'INSERT', 'UPDATE'],
  geographic_cities: ['SELECT', 'INSERT', 'UPDATE'],
  geographic_city_names: ['SELECT', 'INSERT', 'DELETE'],
  geographic_regions: ['SELECT', 'INSERT', 'UPDATE'],
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
      const sql = readFileSync(sqlPath, 'utf8');
      const started = Date.now();
      await client.query(sql); // One atomic DO statement; any error rolls everything back.
      console.log(`IMPORT: completed in ${Date.now() - started} ms`);
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
