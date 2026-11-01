// Sent over SSH stdin; never imports the application, migration runner or importer.
const fs = require('node:fs');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const root = '/var/www/Tedix_Hunt_BE';
const req = createRequire(root + '/package.json');
const stop = (status, evidence) => { console.log(`${status}: ${evidence}`); process.exit(status === 'FAIL' ? 1 : 2); };
let permission = 'read systemd MainPID and ActiveState for tedixhunt-api';
let client;
(async () => {
  const show = key => cp.execFileSync('systemctl', ['show', 'tedixhunt-api', '--property=' + key, '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (show('ActiveState') !== 'active') stop('BLOCKED', 'development backend is not active');
  const pid = show('MainPID');
  if (!/^[1-9]\d*$/.test(pid)) stop('BLOCKED', 'no running backend MainPID');
  const proc = '/proc/' + pid;
  permission = 'read backend /proc/<MainPID>/environ, cmdline, stat and cwd';
  const snapshot = fs.readFileSync(proc + '/stat', 'utf8');
  const args = fs.readFileSync(proc + '/cmdline', 'utf8').split('\0').filter(Boolean);
  if (fs.realpathSync(proc + '/cwd') !== root || args.length !== 2 || !/\/node$/.test(args[0]) || !['dist/server.js', root + '/dist/server.js'].includes(args[1]))
    stop('BLOCKED', 'unsupported service launch; require direct node dist/server.js in deployment directory');
  const env = Object.fromEntries(fs.readFileSync(proc + '/environ', 'utf8').split('\0').filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  // /proc exposes launch environment, not later dotenv mutations. Never guess a stale .env.
  if (!env.DATABASE_URL) stop('BLOCKED', 'DATABASE_URL absent from process launch environment; effective dotenv-loaded value cannot be read from /proc. Administrator must supply runtime configuration attestation; no environment changes attempted');
  if (Object.keys(env).some(k => /^(NODE_OPTIONS|DOTENV_CONFIG_)/.test(k))) stop('BLOCKED', 'custom Node or dotenv loading requires runtime configuration attestation');
  permission = 'read deployed backend configuration and importer source';
  const poolSource = fs.readFileSync(root + '/dist/lib/postgres.js', 'utf8');
  const configSource = fs.readFileSync(root + '/dist/config/environment.js', 'utf8');
  const importer = fs.readFileSync(root + '/src/scripts/importGeonames.ts', 'utf8');
  if (!poolSource.includes('new Pool({ connectionString: environment.databaseUrl })') || !configSource.includes('databaseUrl: process.env.DATABASE_URL') || !importer.includes('new Pool({connectionString:process.env.DATABASE_URL})'))
    stop('BLOCKED', 'deployed database configuration contract differs from reviewed backend/importer');
  // Code changed since process start cannot establish what the process loaded.
  const elapsed = Number(cp.execFileSync('ps', ['-o', 'etimes=', '-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  if (!Number.isFinite(elapsed)) stop('BLOCKED', 'cannot establish process start time');
  for (const file of ['dist/server.js', 'dist/lib/postgres.js', 'dist/config/environment.js'])
    if (fs.statSync(root + '/' + file).mtimeMs >= Date.now() - (elapsed + 2) * 1000) stop('BLOCKED', 'deployed code changed since backend start');
  console.log('PASS: active development backend; launch DATABASE_URL used by backend and importer Pool configuration; importer not executed');
  // Only allowlisted launch variables enter pg. Never inherit the SSH account DB defaults.
  for (const k of Object.keys(process.env)) if (/^(PG|DATABASE_URL)/.test(k)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (/^PG[A-Z_]+$/.test(k)) process.env[k] = v;
  permission = 'read deployment .env for pg fallback configuration comparison';
  if (fs.existsSync(root + '/.env')) {
    const parsed = req('dotenv').parse(fs.readFileSync(root + '/.env'));
    if (Object.keys(parsed).some(k => /^PG/.test(k) && env[k] === undefined))
      stop('BLOCKED', 'dotenv supplies pg fallback settings absent from launch environment; runtime configuration attestation required');
  }
  const { Client } = req('pg');
  client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 10000, options: '-c default_transaction_read_only=on' });
  client.on('error', () => stop('BLOCKED', 'database connection interrupted; raw error suppressed'));
  permission = 'CONNECT on designated development database';
  await client.connect();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const query = async (sql, need) => { permission = need; return (await client.query(sql)).rows; };
  const [identity] = await query('SELECT current_database() AS db, current_user AS usr, session_user AS login, inet_server_addr()::text AS addr, inet_server_port() AS port', 'CONNECT and read PostgreSQL session identity');
  if (identity.db !== 'tedix_hunt' || identity.usr !== 'tedix_app' || identity.login !== 'tedix_app') stop('FAIL', 'database or role differs from tedix_hunt / tedix_app');
  console.log('PASS: database tedix_hunt; current and session user tedix_app');
  const [control] = await query('SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()', 'EXECUTE on function pg_catalog.pg_control_system()');
  const expected = process.argv.slice(2);
  if (control.id !== expected[0] || identity.addr !== expected[1] || String(identity.port) !== expected[2]) stop('FAIL', 'PostgreSQL cluster identity or server endpoint differs from independent pgAdmin evidence');
  console.log('PASS: PostgreSQL cluster system identifier and server address/port match independent tedixhunt_dev evidence (values withheld)');
  for (const table of ['schema_migrations', 'countries', 'localities', 'geographic_imports', 'geographic_cities', 'geographic_city_names']) {
    const [r] = await query(`SELECT to_regclass('public.${table}') IS NOT NULL AS present`, 'USAGE on schema public');
    if (!r.present) stop('FAIL', 'required public.' + table + ' missing');
  }
  const rows = await query("SELECT id FROM public.schema_migrations WHERE id IN ('032_geographic_catalog','033_geographic_import_completion','034_geonames_kosovo_country')", 'USAGE on schema public and SELECT on public.schema_migrations');
  if (rows.length !== 3) stop('FAIL', 'migrations 032–034 incomplete');
  console.log('PASS: migrations 032–034 recorded; all catalog and reference tables exist');
  const [counts] = await query('SELECT (SELECT count(*)::text FROM public.geographic_cities) AS cities, (SELECT count(*)::text FROM public.geographic_imports) AS imports', 'USAGE on schema public and SELECT on public.geographic_cities and public.geographic_imports');
  if (counts.cities !== '0' || counts.imports !== '0') stop('FAIL', 'catalog differs from independently verified zero-city / no-import baseline; counts withheld');
  console.log('PASS: current cities=0; import history=0');
  await client.query('ROLLBACK');
  if (show('MainPID') !== pid || fs.readFileSync(proc + '/stat', 'utf8').split(') ')[1].split(' ')[19] !== snapshot.split(') ')[1].split(' ')[19]) stop('BLOCKED', 'backend process changed during verification');
  console.log('PASS: development database binding verified; read-only transaction rolled back');
})().catch(error => {
  if (['EACCES', 'EPERM', '42501'].includes(error.code)) stop('BLOCKED', 'missing permission: ' + permission);
  stop('BLOCKED', 'unable to complete: ' + permission + '; raw error suppressed');
}).finally(async () => { if (client) await client.end().catch(() => {}); });
