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
    "node_modules/dotenv/lib/main.js": "46c50c6399a53bde79a1f85e720a80a073cb959b21072fad44a98b1bde72c3c2",
    "node_modules/dotenv/config.js": "cd401a4aeb31f30ee55c295b0b65fccb6f1a0e3b7dfd2def4f69dd2a13a8fef2",
    "node_modules/dotenv/lib/env-options.js": "3f8b820081078d1c49737eb257d033881c6d16ee82322c33f229cd38fbb22108",
    "node_modules/dotenv/lib/cli-options.js": "927537ee249dd941a5115b58ccadcc90c52bcbf9ae51cd5853251020686096e3"
  }
};

// Compare addresses as bytes, including IPv4-mapped IPv6, without printing them.
function ipKey(address) {
  const net = require('node:net');
  if (net.isIP(address) === 4) return address.split('.').map(n => Number(n).toString(16).padStart(2, '0')).join('');
  if (net.isIP(address) !== 6) return null;
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const i = text.lastIndexOf(':');
    const bytes = ipKey(text.slice(i + 1));
    text = text.slice(0, i + 1) + bytes.slice(0, 4) + ':' + bytes.slice(4);
  }
  const halves = text.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const hex = words.map(word => word.padStart(4, '0')).join('');
  return hex.startsWith('00000000000000000000ffff') ? hex.slice(24) : hex;
}
function ownedTcpSockets(fs, proc) {
  const inodes = new Set();
  for (const fd of fs.readdirSync(proc + '/fd')) {
    let target;
    try { target = fs.readlinkSync(proc + '/fd/' + fd); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]);
  }
  const sockets = [];
  const endpoint = field => {
    const [hex, port] = field.split(':');
    const words = hex.match(/.{8}/g);
    const bytes = Buffer.concat(words.map(word => {
      const b = Buffer.from(word, 'hex');
      return require('node:os').endianness() === 'LE' ? b.reverse() : b;
    }));
    const key = bytes.toString('hex');
    return { address: key.startsWith('00000000000000000000ffff') ? key.slice(24) : key, port: parseInt(port, 16) };
  };
  for (const file of ['tcp', 'tcp6']) {
    let contents;
    try { contents = fs.readFileSync(proc + '/net/' + file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const line of contents.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '01' || !inodes.has(fields[9])) continue;
      sockets.push({ inode: fields[9], local: endpoint(fields[1]), remote: endpoint(fields[2]) });
    }
  }
  return sockets;
}
function sessionMatches(socket, session, identity) {
  return socket.remote.address === ipKey(identity.addr) && socket.remote.port === Number(identity.port)
    && socket.local.address === ipKey(session.client_addr) && socket.local.port === Number(session.client_port);
}

async function verify({ fs = require('node:fs'), cp = require('node:child_process'),
  crypto = require('node:crypto'), dns = require('node:dns').promises, runtime = process,
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
    if (Object.keys(env).some(k => /^(NODE_OPTIONS|NODE_PATH|DOTENV_KEY|DOTENV_CONFIG_)/.test(k))) stop('BLOCKED_LOADERS');
    need = 'CONTRACT';
    const elapsed = Number(cp.execFileSync('ps', ['-o', 'etimes=', '-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim());
    if (!Number.isFinite(elapsed) || elapsed < 0) stop('BLOCKED_PROCESS_TIME');
    for (const [file, hash] of Object.entries(CONTRACT.files)) {
      if (crypto.createHash('sha256').update(fs.readFileSync(ROOT + '/' + file)).digest('hex') !== hash) stop('BLOCKED_CONTRACT');
      if (fs.statSync(ROOT + '/' + file).mtimeMs >= Date.now() - (elapsed + 2) * 1000) stop('BLOCKED_CHANGED_CODE');
    }
    // This is only a CURRENT importer candidate, never a historical runtime
    // snapshot. Database identity and an independently observed backend socket
    // must corroborate it before any binding PASS can be reported.
    need = 'DOTENV_FILE';
    const readDotenv = () => {
      try { return fs.readFileSync(ROOT + '/.env'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const dotenvBytes = readDotenv();
    const parsed = dotenvBytes === null ? {} : load('dotenv').parse(dotenvBytes);
    const candidate = Object.assign(Object.create(null), parsed, env); // dotenv default: launch wins
    let url;
    try { url = new URL(candidate.DATABASE_URL); } catch { stop('BLOCKED_EFFECTIVE_CONFIG'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || !url.pathname.slice(1)) stop('BLOCKED_EFFECTIVE_CONFIG');
    // These external files can change after startup; do not infer cached values.
    if (candidate.PGPASSFILE || candidate.PGSERVICE || candidate.PGSERVICEFILE || [...url.searchParams.keys()].some(k => /^(sslcert|sslkey|sslrootcert)$/.test(k))) stop('BLOCKED_EXTERNAL_CONFIG');
    evidence.push('PASS_CONFIG_CANDIDATE');
    for (const k of Object.keys(runtime.env)) if (/^(PG|DATABASE_URL)/.test(k)) delete runtime.env[k];
    for (const [k, v] of Object.entries(candidate)) if (/^PG[A-Z_]+$/.test(k)) runtime.env[k] = v;
    const { Client } = load('pg');
    client = new Client({ connectionString: candidate.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout: 10000, statement_timeout: 10000 });
    // Do not exit/throw from an asynchronous EventEmitter callback. The finally
    // path owns rollback and close even when the connection fails mid-query.
    client.on('error', () => { connectionError = true; });
    // Resolve the candidate's actual pg endpoint before opening a DB connection.
    // A stale .env pointing elsewhere must not cause access to another server.
    need = 'CANDIDATE_ENDPOINT';
    const parameters = client.connectionParameters;
    if (parameters.user !== 'tedix_app' || parameters.database !== 'tedix_hunt') stop('FAIL_DATABASE_ROLE');
    if (Number(parameters.port) !== Number(expected[2])) stop('FAIL_CANDIDATE_ENDPOINT');
    const addresses = await dns.lookup(parameters.host, { all: true });
    if (!addresses.length || addresses.some(({ address }) => ipKey(address) !== ipKey(expected[1]))) stop('FAIL_CANDIDATE_ENDPOINT');
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
    const readSockets = () => { need = 'PROC_SOCKETS'; return ownedTcpSockets(fs, proc); };
    const sessionsSql = "SELECT pid, backend_start::text AS started, client_addr::text AS client_addr, client_port FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend' AND datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()";
    const beforeSockets = readSockets();
    const sessions = await query(sessionsSql, 'BACKEND_SESSIONS');
    const afterSockets = readSockets();
    const sameSocket = (a, b) => a.inode === b.inode && JSON.stringify(a) === JSON.stringify(b);
    const matches = [];
    for (const socket of beforeSockets) for (const session of sessions)
      if (Number.isInteger(session.pid) && session.pid > 0 && typeof session.started === 'string' && session.started && sessionMatches(socket, session, identity) && afterSockets.some(other => sameSocket(socket, other))) matches.push({ socket, session });
    if (!matches.length) stop('BLOCKED_RUNTIME_BINDING');
    evidence.push('PASS_RUNTIME_BINDING');
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
    // Refresh PostgreSQL statistics instead of reusing a transaction snapshot.
    await query('SELECT pg_catalog.pg_stat_clear_snapshot()', 'BACKEND_SESSIONS');
    const finalSessions = await query(sessionsSql, 'BACKEND_SESSIONS');
    const finalSockets = readSockets();
    if (!matches.some(({ socket, session }) => finalSockets.some(other => sameSocket(socket, other))
      && finalSessions.some(other => other.pid === session.pid && other.started === session.started && sessionMatches(socket, other, identity)))) stop('BLOCKED_RUNTIME_BINDING');
    need = 'DOTENV_FILE';
    const finalDotenv = readDotenv();
    if ((dotenvBytes === null) !== (finalDotenv === null) || (dotenvBytes !== null && !dotenvBytes.equals(finalDotenv))) stop('BLOCKED_CONFIG_CHANGED');
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
module.exports = { verify, CONTRACT, ipKey, ownedTcpSockets };
if (!module.parent) verify().then(({ evidence, result, exitCode }) => {
  for (const code of [...evidence, result]) console.log('DEV_DB_V1 ' + code);
  process.exitCode = exitCode;
}).catch(() => { console.log('DEV_DB_V1 BLOCKED_UNEXPECTED'); process.exitCode = 2; });
