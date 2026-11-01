// Trust local diagnostic text only. Remote data is a finite code protocol,
// never text to concatenate into a log, annotation or Markdown summary.
const fs = require('node:fs');
const diagnostics = {
  PASS_CONFIG: 'PASS: reviewed configuration contract matches; backend and importer use the same launch DATABASE_URL; importer not executed',
  PASS_DATABASE_ROLE: 'PASS: database tedix_hunt; current and session user tedix_app',
  PASS_SERVER_IDENTITY: 'PASS: cluster identifier and server address/port match independent tedixhunt_dev evidence; values withheld',
  PASS_SCHEMA: 'PASS: migrations 032–034 recorded; catalog and reference tables exist',
  PASS_EMPTY: 'PASS: cities=0; import history=0',
  PASS_COMPLETE: 'PASS: development database binding verified; read-only transaction rolled back and connection closed',
  FAIL_DATABASE_ROLE: 'FAIL: database or role differs from tedix_hunt / tedix_app',
  FAIL_SERVER_IDENTITY: 'FAIL: cluster identifier or server endpoint differs from independent pgAdmin evidence',
  FAIL_TABLES: 'FAIL: required public catalog/reference table missing',
  FAIL_MIGRATIONS: 'FAIL: migrations 032–034 incomplete',
  FAIL_CATALOG: 'FAIL: catalog differs from zero-city / no-import baseline',
  BLOCKED_IDENTITY_INPUT: 'BLOCKED: independently recorded pgAdmin server identity missing or invalid',
  BLOCKED_INACTIVE: 'BLOCKED: development backend is not active',
  BLOCKED_PID: 'BLOCKED: backend MainPID unavailable',
  BLOCKED_LAUNCH: 'BLOCKED: unsupported service launch; direct node dist/server.js in deployment directory required',
  BLOCKED_EFFECTIVE_CONFIG: 'BLOCKED: effective service database configuration cannot be established from launch environment; no .env substitution attempted',
  BLOCKED_LOADERS: 'BLOCKED: custom Node/dotenv loading requires independent runtime configuration evidence',
  BLOCKED_PROCESS_TIME: 'BLOCKED: backend start time unavailable',
  BLOCKED_CONTRACT: 'BLOCKED: deployed artifacts differ from reviewed configuration contract version 1; review this build before verification',
  BLOCKED_CHANGED_CODE: 'BLOCKED: deployed configuration artifacts changed since backend start',
  BLOCKED_DOTENV_FILE: 'BLOCKED: dotenv file exists; historical pg fallback configuration cannot be established from launch environment',
  BLOCKED_EXTERNAL_CONFIG: 'BLOCKED: external credential or TLS configuration cannot be established for the running service',
  BLOCKED_PROCESS_CHANGED: 'BLOCKED: backend process changed during verification',
  BLOCKED_CLEANUP: 'BLOCKED: transaction rollback or connection cleanup could not be confirmed',
  BLOCKED_CONNECTION_LOST: 'BLOCKED: database connection interrupted; verification incomplete',
  BLOCKED_UNEXPECTED: 'BLOCKED: verification incomplete; raw error suppressed',
};
const operations = {
  SYSTEMD: 'read systemd MainPID and ActiveState for tedixhunt-api',
  PROC_METADATA: 'read backend /proc/<MainPID>/stat, cmdline and cwd',
  PROC_ENVIRON: 'read backend /proc/<MainPID>/environ',
  CONTRACT: 'read reviewed deployed configuration artifacts and metadata',
  DOTENV_METADATA: 'read metadata for deployment .env',
  CONNECT: 'CONNECT on designated development database',
  READ_ONLY_TRANSACTION: 'begin a read-only transaction on the development database',
  SESSION_IDENTITY: 'read PostgreSQL session identity',
  IDENTITY_ACL: 'execute pg_catalog.has_function_privilege for the current role',
  PG_CONTROL: 'EXECUTE on function pg_catalog.pg_control_system()',
  SCHEMA: 'USAGE on schema public',
  MIGRATIONS: 'USAGE on schema public and SELECT on public.schema_migrations',
  CATALOG: 'USAGE on schema public and SELECT on public.geographic_cities and public.geographic_imports',
};
for (const [code, text] of Object.entries(operations)) {
  diagnostics['BLOCKED_PERMISSION_' + code] = 'BLOCKED: missing permission: ' + text + '; no escalation attempted';
  diagnostics['BLOCKED_UNAVAILABLE_' + code] = 'BLOCKED: unable to complete: ' + text + '; raw error suppressed';
}
function render(raw, remoteExit) {
  const invalid = { text: 'BLOCKED: remote verification protocol incomplete or invalid; remote output withheld\n', exitCode: 2 };
  if (Buffer.byteLength(raw) > 32768) return invalid;
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  // Fail closed on ANY non-protocol output, including banners and control bytes.
  if (!lines.length || lines.length > 16 || lines.some(line => !/^DEV_DB_V1 [A-Z_]+$/.test(line) || !Object.hasOwn(diagnostics, line.slice(10)))) return invalid;
  const codes = lines.map(line => line.slice(10));
  const final = codes.at(-1);
  const progress = ['PASS_CONFIG', 'PASS_DATABASE_ROLE', 'PASS_SERVER_IDENTITY', 'PASS_SCHEMA', 'PASS_EMPTY'];
  if (codes.slice(0, -1).some((code, i) => code !== progress[i])) return invalid;
  const exitCode = final === 'PASS_COMPLETE' ? 0 : final.startsWith('FAIL_') ? 1 : final.startsWith('BLOCKED_') ? 2 : -1;
  if (exitCode < 0 || Number(remoteExit) !== exitCode || (exitCode === 0 && codes.length !== 6)) return invalid;
  return { text: codes.map(code => diagnostics[code]).join('\n') + '\n', exitCode };
}
module.exports = { render, diagnostics };
if (require.main === module) {
  const [rawPath, reportPath, remoteExit] = process.argv.slice(2);
  let result;
  try {
    if (fs.statSync(rawPath).size > 32768) throw new Error();
    result = render(fs.readFileSync(rawPath, 'utf8'), remoteExit);
  } catch { result = render('', remoteExit); }
  fs.writeFileSync(reportPath, result.text, { mode: 0o600 });
  process.stdout.write(result.text);
  process.exitCode = result.exitCode;
}
