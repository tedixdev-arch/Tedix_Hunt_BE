// Read-only probe, sent over SSH stdin. No application entrypoints are imported.
const ROOT = '/var/www/Tedix_Hunt_BE';
// Versioned, reviewed artifact contract, generated with TypeScript 5.9.3 from
// main 1cc79aa. A changed build blocks until its configuration path is reviewed.
const CONTRACT = {
  "version": 1,
  "sourceRevision": "1cc79aaebfffa3f477dd967ed2727f7675c9c212",
  "typescript": "5.9.3",
  "files": {
    "dist/server.js": "9532ccfd477a41445a70270bd32107f6d513e21cf5fc4d3cd8b4d6082f4f0f13",
    "dist/config/environment.js": "069b3d5e915cbd50f4083dc5b63d32816256b606aaebc6ff4c6d86464aa799bf",
    "dist/lib/postgres.js": "2652ff6177aae4bd59a7df36f71a8f6cfea15fe8e7d8424294010b5f9f84c5d1",
    "src/scripts/importGeonames.ts": "1a4c2af07b40d6c6c704bb80a6f36de60bd6559f579145d700903db6f7ecf3df",
    "package-lock.json": "1fe0ece1e00362cb766019d5d82995fac059507b410971c98740e8166208d44b",
    "node_modules/pg/lib/connection-parameters.js": "6b6548f99acba3502663a17a180582ba8e1f1725aa9d94b5f47cac19dcb6211b",
    "node_modules/pg/lib/defaults.js": "d91c22d082ec974f9f878a71e8d9d56a7e5fa9a711cc63f32522b43f5e9169d4",
    "node_modules/pg-connection-string/index.js": "6523b5d5ad961775b9befa691edccf8080a79da52b91142834f9e6f6d75eb5e3",
    "node_modules/dotenv/lib/main.js": "46c50c6399a53bde79a1f85e720a80a073cb959b21072fad44a98b1bde72c3c2"
  }
};

async function verify({ fs = require('node:fs'), cp = require('node:child_process'),
  crypto = require('node:crypto'), runtime = process,
  load = require('node:module').createRequire(ROOT + '/package.json') } = {}) {
  const evidence = [];
  let client, transaction = false, need = 'SYSTEMD', result = 'BLOCKED_UNEXPECTED';
  let connectionError = false;
  const stop = code => { throw Object.assign(new Error(), { diagnostic: code }); };
  const show = key => cp.execFileSync('systemctl', ['show', 'tedixhunt-api', '--property=' + key, '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  try {
    const expected = runtime.argv.slice(2);
    if (expected.length !== 3 || !/^\d{1,20}$/.test(expected[0]) || !/^[0-9a-fA-F.:]+$/.test(expected[1]) || !/^\d{1,5}$/.test(expected[2])) stop('BLOCKED_IDENTITY_INPUT');
    if (show('ActiveState') !== 'active') stop('BLOCKED_INACTIVE');
    const pid = show('MainPID');
    if (!/^[1-9]\d*$/.test(pid)) stop('BLOCKED_PID');
    const proc = '/proc/' + pid;
    need = 'PROC_METADATA';
    const snapshot = fs.readFileSync(proc + '/stat', 'utf8');
    const startTicks = stat => stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
    const args = fs.readFileSync(proc + '/cmdline', 'utf8').split('\0').filter(Boolean);
    if (fs.realpathSync(proc + '/cwd') !== ROOT || args.length !== 2 || !/\/node$/.test(args[0]) || !['dist/server.js', ROOT + '/dist/server.js'].includes(args[1])) stop('BLOCKED_LAUNCH');
    need = 'PROC_ENVIRON';
    const env = Object.fromEntries(fs.readFileSync(proc + '/environ', 'utf8').split('\0').filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
    if (!env.DATABASE_URL) stop('BLOCKED_EFFECTIVE_CONFIG');
    if (Object.keys(env).some(k => /^(NODE_OPTIONS|NODE_PATH|DOTENV_CONFIG_)/.test(k))) stop('BLOCKED_LOADERS');
    need = 'CONTRACT';
    const elapsed = Number(cp.execFileSync('ps', ['-o', 'etimes=', '-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim());
    if (!Number.isFinite(elapsed) || elapsed < 0) stop('BLOCKED_PROCESS_TIME');
    for (const [file, hash] of Object.entries(CONTRACT.files)) {
      if (crypto.createHash('sha256').update(fs.readFileSync(ROOT + '/' + file)).digest('hex') !== hash) stop('BLOCKED_CONTRACT');
      if (fs.statSync(ROOT + '/' + file).mtimeMs >= Date.now() - (elapsed + 2) * 1000) stop('BLOCKED_CHANGED_CODE');
    }
    // Historical dotenv pg fallbacks cannot be recovered from /proc. Even an
    // unchanged-looking .env is not a runtime snapshot. Never use its contents.
    // Require a launch-time config with no dotenv file and a complete URL.
    need = 'DOTENV_METADATA';
    try {
      fs.statSync(ROOT + '/.env');
      stop('BLOCKED_DOTENV_FILE');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let url;
    try { url = new URL(env.DATABASE_URL); } catch { stop('BLOCKED_EFFECTIVE_CONFIG'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1)) stop('BLOCKED_EFFECTIVE_CONFIG');
    // These external files can change after startup; do not infer cached values.
    if (env.PGPASSFILE || env.PGSERVICE || env.PGSERVICEFILE || [...url.searchParams.keys()].some(k => /^(sslcert|sslkey|sslrootcert)$/.test(k))) stop('BLOCKED_EXTERNAL_CONFIG');
    evidence.push('PASS_CONFIG');
    for (const k of Object.keys(runtime.env)) if (/^(PG|DATABASE_URL)/.test(k)) delete runtime.env[k];
    for (const [k, v] of Object.entries(env)) if (/^PG[A-Z_]+$/.test(k)) runtime.env[k] = v;
    const { Client } = load('pg');
    client = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout: 10000, statement_timeout: 10000 });
    // Do not exit/throw from an asynchronous EventEmitter callback. The finally
    // path owns rollback and close even when the connection fails mid-query.
    client.on('error', () => { connectionError = true; });
    need = 'CONNECT';
    await client.connect();
    need = 'READ_ONLY_TRANSACTION';
    transaction = true; // also attempt rollback if BEGIN itself fails
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const query = async (sql, permission) => { need = permission; return (await client.query(sql)).rows; };
    const [identity] = await query('SELECT current_database() AS db, current_user AS usr, session_user AS login, inet_server_addr()::text AS addr, inet_server_port() AS port', 'SESSION_IDENTITY');
    if (identity.db !== 'tedix_hunt' || identity.usr !== 'tedix_app' || identity.login !== 'tedix_app') stop('FAIL_DATABASE_ROLE');
    evidence.push('PASS_DATABASE_ROLE');
    // Check the actual tedix_app ACL, including inherited grants, before calling
    // the restricted function. No grants or role changes are attempted.
    const [acl] = await query("SELECT has_function_privilege(current_user, 'pg_catalog.pg_control_system()', 'EXECUTE') AS allowed", 'IDENTITY_ACL');
    if (!acl.allowed) stop('BLOCKED_PERMISSION_PG_CONTROL');
    const [control] = await query('SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()', 'PG_CONTROL');
    if (control.id !== expected[0] || identity.addr !== expected[1] || String(identity.port) !== expected[2]) stop('FAIL_SERVER_IDENTITY');
    evidence.push('PASS_SERVER_IDENTITY');
    for (const table of ['schema_migrations', 'countries', 'localities', 'geographic_imports', 'geographic_cities', 'geographic_city_names']) {
      const [row] = await query(`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = to_regclass('public.${table}') AND relkind IN ('r','p')) AS present`, 'SCHEMA');
      if (!row.present) stop('FAIL_TABLES');
    }
    const rows = await query("SELECT id FROM public.schema_migrations WHERE id IN ('032_geographic_catalog','033_geographic_import_completion','034_geonames_kosovo_country')", 'MIGRATIONS');
    if (rows.length !== 3) stop('FAIL_MIGRATIONS');
    evidence.push('PASS_SCHEMA');
    const [counts] = await query('SELECT (SELECT count(*)::text FROM public.geographic_cities) AS cities, (SELECT count(*)::text FROM public.geographic_imports) AS imports', 'CATALOG');
    if (counts.cities !== '0' || counts.imports !== '0') stop('FAIL_CATALOG');
    evidence.push('PASS_EMPTY');
    need = 'PROC_METADATA';
    if (show('MainPID') !== pid || startTicks(fs.readFileSync(proc + '/stat', 'utf8')) !== startTicks(snapshot)) stop('BLOCKED_PROCESS_CHANGED');
    result = 'PASS_COMPLETE';
  } catch (error) {
    result = error.diagnostic ?? (['EACCES', 'EPERM', '42501'].includes(error.code) ? 'BLOCKED_PERMISSION_' : 'BLOCKED_UNAVAILABLE_') + need;
  } finally {
    // No process.exit: all failure paths reach this block, including mismatches,
    // permission failures and errors before/inside BEGIN. End is always attempted.
    let cleanupFailed = false;
    if (client) {
      if (transaction) try { await client.query('ROLLBACK'); } catch { cleanupFailed = true; }
      try { await client.end(); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) result = 'BLOCKED_CLEANUP';
    else if (connectionError) result = 'BLOCKED_CONNECTION_LOST';
  }
  return { evidence, result, exitCode: result === 'PASS_COMPLETE' ? 0 : result.startsWith('FAIL_') ? 1 : 2 };
}
module.exports = { verify, CONTRACT };
if (!module.parent) verify().then(({ evidence, result, exitCode }) => {
  for (const code of [...evidence, result]) console.log('DEV_DB_V1 ' + code);
  process.exitCode = exitCode;
}).catch(() => { console.log('DEV_DB_V1 BLOCKED_UNEXPECTED'); process.exitCode = 2; });
