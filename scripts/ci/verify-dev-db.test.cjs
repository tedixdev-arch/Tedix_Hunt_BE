const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { verify, CONTRACT, ipKey, ownedTcpSockets } = require('./verify-dev-db.cjs');
const { render, diagnostics } = require('./render-dev-db-report.cjs');
const ROOT = '/var/www/Tedix_Hunt_BE';
const URL = 'postgresql://tedix_app:hidden@127.0.0.1:5432/tedix_hunt';
const tableHeader = 'sl local_address rem_address st tx_queue tr retrnsmt uid timeout inode\n';
function tcpLine(inode = '777', ipv6 = false) {
  const word = hex => require('node:os').endianness() === 'LE' ? Buffer.from(hex, 'hex').reverse().toString('hex') : hex;
  const addr = ipv6 ? ['00000000', '00000000', '0000ffff', '7f000001'].map(word).join('') : word('7f000001');
  return `0: ${addr}:C350 ${addr}:1538 01 0:0 00:0 0 1000 0 ${inode} 1\n`;
}
function fixture(mode) {
  const calls = [], initialEnv = { PGHOST: 'ssh-account-must-not-leak', DATABASE_URL: 'ssh-account-must-not-leak' };
  let event, reads = 0, dotenvReads = 0, fdReads = 0, sessionReads = 0, config;
  const error = code => Object.assign(new Error('PASSWORD_CONNECTION_STRING_SECRET'), { code });
  const fakeFs = {
    realpathSync: () => ROOT,
    readdirSync: () => { if (mode === 'fd-permission') throw error('EACCES'); return mode === 'no-socket' ? [] : ['7']; },
    readlinkSync: () => { fdReads++; return mode === 'socket-race' && fdReads > 1 ? 'socket:[999]' : 'socket:[777]'; },
    statSync: () => ({ mtimeMs: mode === 'changed-code' ? Date.now() : 0 }),
    readFileSync: path => {
      if (path.endsWith('/stat')) return '42 (node name) ' + Array(25).fill('1').join(' ');
      if (path.endsWith('/cmdline')) return '/usr/bin/node\0dist/server.js\0';
      if (path.endsWith('/environ')) {
        if (mode === 'proc-permission') throw error('EACCES');
        if (mode === 'launch-override') return 'DATABASE_URL=' + URL + '\0PGAPPNAME=launch-wins\0';
        if (mode === 'custom-loader') return 'DOTENV_CONFIG_OVERRIDE=true\0';
        return 'JWT_SECRET=not-used-by-probe\0'; // real dotenv-only service launch
      }
      if (path.endsWith('/.env')) {
        dotenvReads++;
        if (mode === 'dotenv-missing') throw error('ENOENT');
        if (mode === 'dotenv-permission') throw error('EACCES');
        let text = 'DATABASE_URL="' + URL + '"\nPGAPPNAME=dotenv-importer\n';
        if (mode === 'launch-override') text = 'DATABASE_URL=postgresql://wrong:hidden@192.0.2.1:5432/wrong\nPGAPPNAME=dotenv-loses\n';
        if (mode === 'stale-candidate') text = 'DATABASE_URL=postgresql://tedix_app:hidden@192.0.2.1:5432/tedix_hunt\n';
        if (mode === 'updated-dotenv-same-target') text += '# edited after service start; not historical runtime evidence\n';
        if (mode === 'config-race' && dotenvReads > 1) text += '# changed\n';
        return Buffer.from(text);
      }
      if (path.includes('/net/')) {
        if (mode === 'net-permission') throw error('EACCES');
        const ipv6 = mode === 'ipv6-mapped';
        return tableHeader + (path.endsWith(ipv6 ? '/tcp6' : '/tcp') ? tcpLine(mode === 'unowned-socket' ? '888' : '777', ipv6) : '');
      }
      reads++;
      const bytes = fs.readFileSync(path.slice(ROOT.length + 1));
      return mode === 'unknown-contract' ? Buffer.from('different build') : bytes;
    },
  };
  class Client {
    constructor(options) {
      calls.push('construct'); config = options;
      const u = new globalThis.URL(options.connectionString);
      this.connectionParameters = { host: u.hostname, port: u.port, user: u.username, database: u.pathname.slice(1) };
    }
    on(_, handler) { event = handler; }
    async connect() { calls.push('connect'); if (mode === 'connect-fail') throw error('ECONNREFUSED'); }
    async end() { calls.push('end'); if (mode === 'end-fail') throw error('EIO'); }
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('BEGIN') && mode === 'begin-fail') throw error('08006');
      if (sql === 'ROLLBACK' && mode === 'rollback-fail') throw error('08006');
      if (sql.includes('current_database() AS db')) {
        if (mode === 'connection-event') event(error('08006'));
        return { rows: [{ db: mode === 'wrong-db' ? 'wrong' : 'tedix_hunt', usr: 'tedix_app', login: 'tedix_app', addr: '127.0.0.1', port: 5432 }] };
      }
      if (sql.includes('has_function_privilege')) return { rows: [{ allowed: mode !== 'acl-denied' }] };
      if (sql.includes('system_identifier')) {
        if (mode === 'function-denied') throw error('42501');
        return { rows: [{ id: mode === 'wrong-cluster' ? '2' : '1' }] };
      }
      if (sql.includes('pg_stat_activity')) {
        sessionReads++;
        if (mode === 'session-permission') throw error('42501');
        if (mode === 'no-session' || (mode === 'session-race' && sessionReads > 1)) return { rows: [] };
        return { rows: [{ pid: 123, started: 'fixed-start-time', client_addr: '127.0.0.1', client_port: mode === 'wrong-session' ? 51000 : 50000 }] };
      }
      if (sql.includes('to_regclass')) return { rows: [{ present: mode !== 'missing-table' }] };
      if (sql.includes('SELECT id')) return { rows: mode === 'missing-migration' ? [] : [{}, {}, {}] };
      if (sql.includes('count(*)')) return { rows: [{ cities: mode === 'nonempty' ? '1' : '0', imports: '0' }] };
      return { rows: [] };
    }
  }
  const cp = { execFileSync: (_, args) => args.includes('etimes=') ? '1000' : args.includes('--property=MainPID') ? '42' : 'active' };
  const dns = { lookup: async host => [{ address: host }] };
  return { deps: { fs: fakeFs, cp, crypto, dns, runtime: { argv: ['node', '-', '1', '127.0.0.1', '5432'], env: initialEnv }, load: name => name === 'dotenv' ? dotenv : { Client } }, calls, initialEnv, readCount: () => reads, config: () => config };
}
const cases = {
  pass: 'PASS_COMPLETE', 'updated-dotenv-same-target': 'PASS_COMPLETE', 'launch-override': 'PASS_COMPLETE', 'ipv6-mapped': 'PASS_COMPLETE',
  'proc-permission': 'BLOCKED_PERMISSION_PROC_ENVIRON', 'dotenv-missing': 'BLOCKED_EFFECTIVE_CONFIG',
  'dotenv-permission': 'BLOCKED_PERMISSION_DOTENV_FILE', 'custom-loader': 'BLOCKED_LOADERS',
  'stale-candidate': 'FAIL_CANDIDATE_ENDPOINT', 'config-race': 'BLOCKED_CONFIG_CHANGED',
  'unknown-contract': 'BLOCKED_CONTRACT', 'changed-code': 'BLOCKED_CHANGED_CODE',
  'connect-fail': 'BLOCKED_UNAVAILABLE_CONNECT', 'begin-fail': 'BLOCKED_UNAVAILABLE_READ_ONLY_TRANSACTION',
  'acl-denied': 'BLOCKED_PERMISSION_PG_CONTROL', 'function-denied': 'BLOCKED_PERMISSION_PG_CONTROL',
  'wrong-db': 'FAIL_DATABASE_ROLE', 'wrong-cluster': 'FAIL_SERVER_IDENTITY',
  'no-socket': 'BLOCKED_RUNTIME_BINDING', 'unowned-socket': 'BLOCKED_RUNTIME_BINDING',
  'fd-permission': 'BLOCKED_PERMISSION_PROC_SOCKETS', 'net-permission': 'BLOCKED_PERMISSION_PROC_SOCKETS',
  'no-session': 'BLOCKED_RUNTIME_BINDING', 'wrong-session': 'BLOCKED_RUNTIME_BINDING',
  'socket-race': 'BLOCKED_RUNTIME_BINDING', 'session-race': 'BLOCKED_RUNTIME_BINDING',
  'session-permission': 'BLOCKED_PERMISSION_BACKEND_SESSIONS',
  'missing-table': 'FAIL_TABLES', 'missing-migration': 'FAIL_MIGRATIONS', nonempty: 'FAIL_CATALOG',
  'rollback-fail': 'BLOCKED_CLEANUP', 'end-fail': 'BLOCKED_CLEANUP', 'connection-event': 'BLOCKED_CONNECTION_LOST',
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
  if (mode === 'stale-candidate') assert(!f.calls.includes('connect'));
  if (expected === 'PASS_COMPLETE') {
    assert.equal(f.initialEnv.PGHOST, undefined);
    assert.equal(f.config().connectionString, URL);
    assert.equal(f.initialEnv.PGAPPNAME, mode === 'launch-override' ? 'launch-wins' : 'dotenv-importer');
  }
  const report = render([...result.evidence, result.result].map(code => 'DEV_DB_V1 ' + code).join('\n') + '\n', result.exitCode);
  assert.equal(report.exitCode, result.exitCode);
  assert(!report.text.includes('SECRET'));
});
test('address normalization and socket ownership respect IPv4, IPv6 and native word order', () => {
  assert.equal(ipKey('127.0.0.1'), ipKey('::ffff:127.0.0.1'));
  assert.equal(ipKey('127.0.0.1'), ipKey('::ffff:7f00:1'));
  assert.equal(ipKey('::1'), ipKey('0:0:0:0:0:0:0:1'));
  assert.notEqual(ipKey('127.0.0.1'), ipKey('::1'));
  assert.equal(ipKey('not-an-address'), null);
  assert.equal(ownedTcpSockets(fixture('unowned-socket').deps.fs, '/proc/42').length, 0);
});
test('reviewed dotenv defaults preserve launch values, including empty values', () => {
  const env = { DATABASE_URL: URL, PGAPPNAME: '' };
  const parsed = dotenv.parse(Buffer.from('DATABASE_URL="different"\nPGAPPNAME=from-file\nPGSSLMODE=require\n'));
  assert.deepEqual(Object.assign({}, parsed, env), { DATABASE_URL: URL, PGAPPNAME: '', PGSSLMODE: 'require' });
});
test('contract fingerprints match reviewed build and compiler', () => {
  assert.equal(require('typescript/package.json').version, CONTRACT.typescript);
  for (const [file, digest] of Object.entries(CONTRACT.files)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest, file);
});
test('renderer rejects forged status text, workflow commands, control bytes and unknown codes', () => {
  for (const raw of ['PASS: password=SECRET\n', 'BLOCKED: SECRET\n', 'FAIL: SECRET\n', '::warning::SECRET\n', 'DEV_DB_V1 PASS_CONFIG_CANDIDATE SECRET\n', 'DEV_DB_V1 PASS_CONFIG_CANDIDATE\r\n', 'DEV_DB_V1 UNKNOWN\n', 'DEV_DB_V1 PASS_COMPLETE\n', 'DEV_DB_V1 BLOCKED_UNEXPECTED\nDEV_DB_V1 PASS_CONFIG_CANDIDATE\n', 'x'.repeat(32769)]) {
    const result = render(raw, 0);
    assert.equal(result.exitCode, 2);
    assert(!result.text.includes('SECRET'));
    assert(!result.text.includes('::'));
  }
});
test('renderer requires runtime socket proof and matching SSH exit for success', () => {
  const progress = ['PASS_CONFIG_CANDIDATE', 'PASS_DATABASE_ROLE', 'PASS_SERVER_IDENTITY', 'PASS_RUNTIME_BINDING', 'PASS_SCHEMA', 'PASS_EMPTY', 'PASS_COMPLETE'];
  const raw = progress.map(code => 'DEV_DB_V1 ' + code).join('\n') + '\n';
  assert.equal(render(raw, 0).exitCode, 0);
  assert.equal(render(raw, 255).exitCode, 2);
  assert.equal(render(progress.filter(code => code !== 'PASS_RUNTIME_BINDING').map(code => 'DEV_DB_V1 ' + code).join('\n'), 0).exitCode, 2);
  assert(render('DEV_DB_V1 BLOCKED_PERMISSION_PROC_ENVIRON\n', 2).text.includes('/proc/<MainPID>/environ'));
});
