const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { verify, CONTRACT } = require('./verify-dev-db.cjs');
const { render, diagnostics } = require('./render-dev-db-report.cjs');
const ROOT = '/var/www/Tedix_Hunt_BE';
function fixture(mode) {
  const calls = [], initialEnv = { PGHOST: 'ssh-account-must-not-leak', DATABASE_URL: 'ssh-account-must-not-leak' };
  let event, reads = 0;
  const error = code => Object.assign(new Error('PASSWORD_CONNECTION_STRING_SECRET'), { code });
  const fakeFs = {
    realpathSync: () => ROOT,
    statSync: path => {
      if (path.endsWith('/.env')) {
        if (mode === 'dotenv-file') return { mtimeMs: 0 };
        if (mode === 'dotenv-permission') throw error('EACCES');
        throw error('ENOENT');
      }
      return { mtimeMs: mode === 'changed-code' ? Date.now() : 0 };
    },
    readFileSync: path => {
      if (path.endsWith('/stat')) return '42 (node name) ' + Array(25).fill('1').join(' ');
      if (path.endsWith('/cmdline')) return '/usr/bin/node\0dist/server.js\0';
      if (path.endsWith('/environ')) {
        if (mode === 'proc-permission') throw error('EACCES');
        if (mode === 'dotenv-only') return 'JWT_SECRET=secret\0';
        return 'DATABASE_URL=postgresql://tedix_app:hidden@127.0.0.1:5432/tedix_hunt\0';
      }
      reads++;
      const bytes = fs.readFileSync(path.slice(ROOT.length + 1));
      return mode === 'unknown-contract' ? Buffer.from('different build') : bytes;
    },
  };
  class Client {
    constructor() { calls.push('construct'); }
    on(_, handler) { event = handler; }
    async connect() { calls.push('connect'); if (mode === 'connect-fail') throw error('ECONNREFUSED'); }
    async end() { calls.push('end'); if (mode === 'end-fail') throw error('EIO'); }
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('BEGIN') && mode === 'begin-fail') throw error('08006');
      if (sql === 'ROLLBACK' && mode === 'rollback-fail') throw error('08006');
      if (sql.includes('current_database')) {
        if (mode === 'connection-event') event(error('08006'));
        return { rows: [{ db: mode === 'wrong-db' ? 'wrong' : 'tedix_hunt', usr: 'tedix_app', login: 'tedix_app', addr: '127.0.0.1', port: 5432 }] };
      }
      if (sql.includes('has_function_privilege')) return { rows: [{ allowed: mode !== 'acl-denied' }] };
      if (sql.includes('system_identifier')) {
        if (mode === 'function-denied') throw error('42501');
        return { rows: [{ id: mode === 'wrong-cluster' ? '2' : '1' }] };
      }
      if (sql.includes('to_regclass')) return { rows: [{ present: mode !== 'missing-table' }] };
      if (sql.includes('SELECT id')) return { rows: mode === 'missing-migration' ? [] : [{}, {}, {}] };
      if (sql.includes('count(*)')) return { rows: [{ cities: mode === 'nonempty' ? '1' : '0', imports: '0' }] };
      return { rows: [] };
    }
  }
  const cp = { execFileSync: (_, args) => args.includes('etimes=') ? '1000' : args.includes('--property=MainPID') ? '42' : 'active' };
  return { deps: { fs: fakeFs, cp, crypto, runtime: { argv: ['node', '-', '1', '127.0.0.1', '5432'], env: initialEnv }, load: () => ({ Client }) }, calls, initialEnv, readCount: () => reads };
}
const cases = {
  pass: 'PASS_COMPLETE', 'proc-permission': 'BLOCKED_PERMISSION_PROC_ENVIRON',
  'dotenv-only': 'BLOCKED_EFFECTIVE_CONFIG', 'dotenv-file': 'BLOCKED_DOTENV_FILE',
  'dotenv-permission': 'BLOCKED_PERMISSION_DOTENV_METADATA', 'unknown-contract': 'BLOCKED_CONTRACT',
  'changed-code': 'BLOCKED_CHANGED_CODE', 'connect-fail': 'BLOCKED_UNAVAILABLE_CONNECT',
  'begin-fail': 'BLOCKED_UNAVAILABLE_READ_ONLY_TRANSACTION', 'acl-denied': 'BLOCKED_PERMISSION_PG_CONTROL',
  'function-denied': 'BLOCKED_PERMISSION_PG_CONTROL', 'wrong-db': 'FAIL_DATABASE_ROLE',
  'wrong-cluster': 'FAIL_SERVER_IDENTITY', 'missing-table': 'FAIL_TABLES',
  'missing-migration': 'FAIL_MIGRATIONS', nonempty: 'FAIL_CATALOG',
  'rollback-fail': 'BLOCKED_CLEANUP', 'end-fail': 'BLOCKED_CLEANUP',
  'connection-event': 'BLOCKED_CONNECTION_LOST',
};
for (const [mode, expected] of Object.entries(cases)) test('probe: ' + mode, async () => {
  const f = fixture(mode), result = await verify(f.deps);
  assert.equal(result.result, expected);
  assert(!JSON.stringify(result).includes('SECRET'));
  assert(Object.hasOwn(diagnostics, result.result));
  if (f.calls.includes('construct')) assert.equal(f.calls.at(-1), 'end');
  const queries = f.calls.filter(call => !['construct', 'connect', 'end'].includes(call));
  assert(queries.every(sql => /^(SELECT|BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY$|ROLLBACK$)/.test(sql)));
  if (queries.some(sql => sql.startsWith('BEGIN'))) assert.equal(queries.at(-1), 'ROLLBACK');
  if (mode === 'acl-denied') assert(!queries.some(sql => sql.includes('SELECT system_identifier')));
  if (mode === 'proc-permission') assert.equal(f.readCount(), 0);
  if (mode === 'pass') assert.equal(f.initialEnv.PGHOST, undefined);
  const report = render([...result.evidence, result.result].map(code => 'DEV_DB_V1 ' + code).join('\n') + '\n', result.exitCode);
  assert.equal(report.exitCode, result.exitCode);
  assert(!report.text.includes('SECRET'));
});
test('contract fingerprints match reviewed build and compiler', () => {
  assert.equal(require('typescript/package.json').version, CONTRACT.typescript);
  for (const [file, digest] of Object.entries(CONTRACT.files)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest, file);
});
test('renderer rejects forged status text, workflow commands, control bytes and unknown codes', () => {
  for (const raw of ['PASS: password=SECRET\n', 'BLOCKED: SECRET\n', 'FAIL: SECRET\n', '::warning::SECRET\n', 'DEV_DB_V1 PASS_CONFIG SECRET\n', 'DEV_DB_V1 PASS_CONFIG\r\n', 'DEV_DB_V1 UNKNOWN\n', 'DEV_DB_V1 PASS_COMPLETE\n', 'DEV_DB_V1 BLOCKED_UNEXPECTED\nDEV_DB_V1 PASS_CONFIG\n', 'x'.repeat(32769)]) {
    const result = render(raw, 0);
    assert.equal(result.exitCode, 2);
    assert(!result.text.includes('SECRET'));
    assert(!result.text.includes('::'));
  }
});
test('renderer accepts only complete ordered success with matching SSH exit', () => {
  const raw = ['PASS_CONFIG', 'PASS_DATABASE_ROLE', 'PASS_SERVER_IDENTITY', 'PASS_SCHEMA', 'PASS_EMPTY', 'PASS_COMPLETE'].map(code => 'DEV_DB_V1 ' + code).join('\n') + '\n';
  assert.equal(render(raw, 0).exitCode, 0);
  assert.equal(render(raw, 255).exitCode, 2);
  assert.equal(render('DEV_DB_V1 BLOCKED_PERMISSION_PROC_ENVIRON\n', 2).exitCode, 2);
  assert(render('DEV_DB_V1 BLOCKED_PERMISSION_PROC_ENVIRON\n', 2).text.includes('/proc/<MainPID>/environ'));
});
