import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, lstat, mkdir, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import request from 'supertest';
const query = vi.hoisted(() => vi.fn());
vi.mock('./postgres.js', () => ({ pool: { query } }));
import { startDevelopmentDiagnostic } from './developmentDiagnosticSocket.js';
import { environment } from '../config/environment.js';
import { createApp } from '../app.js';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { safeResponse } = require('../../scripts/ci/invoke-dev-pool.cjs');
const expected = { DEV_PG_SYSTEM_IDENTIFIER: '12345', DEV_PG_SERVER_ADDR: '127.0.0.1', DEV_PG_SERVER_PORT: '5432' };
let root: string, stop: () => Promise<void>;
const original = environment.nodeEnv;
function invoke(path: string, payload = JSON.stringify(expected) + '\n'): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = '';
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('test timeout')); });
    socket.on('connect', () => socket.write(payload));
    socket.on('error', reject);
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  });
}
beforeEach(async () => {
  root = await mkdtemp('/tmp/tedix-diag-test-'); stop = async () => {};
  vi.stubEnv('NODE_ENV', 'development'); environment.nodeEnv = 'development';
  query.mockReset(); query.mockResolvedValue({ rows: [{ database_match: true, role_match: true, cluster_match: true, endpoint_match: true }] });
});
afterEach(async () => { await stop(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); environment.nodeEnv = original; vi.restoreAllMocks(); });
describe('private development control channel', () => {
  it('creates only owner-private Unix socket, uses live Pool and cleans up', async () => {
    stop = await startDevelopmentDiagnostic(`${root}/private`);
    expect((await lstat(`${root}/private`)).mode & 0o777).toBe(0o700);
    const stat = await lstat(`${root}/private/binding.sock`);
    expect(stat.isSocket()).toBe(true); expect(stat.mode & 0o777).toBe(0o600); expect(stat.uid).toBe(process.getuid!());
    expect((await invoke(`${root}/private/binding.sock`)).status).toBe('PASS'); expect(query).toHaveBeenCalledOnce();
    await stop(); stop = async () => {};
    await expect(lstat(`${root}/private`)).rejects.toThrow();
  });
  it.each(['production', 'test', undefined])('does no filesystem work outside explicit development %s', async value => {
    vi.stubEnv('NODE_ENV', value); environment.nodeEnv = value ?? 'development';
    stop = await startDevelopmentDiagnostic(`${root}/private`);
    await expect(lstat(`${root}/private`)).rejects.toThrow(); expect(query).not.toHaveBeenCalled();
  });
  it.each(['directory', 'symlink'])('never adopts existing %s', async kind => {
    if (kind === 'directory') await mkdir(`${root}/private`);
    else await symlink(root, `${root}/private`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stop = await startDevelopmentDiagnostic(`${root}/private`);
    expect(warn).toHaveBeenCalledWith('BLOCKED: PRIVATE_DIAGNOSTIC_UNAVAILABLE');
    expect((await lstat(`${root}/private`)).isSymbolicLink()).toBe(kind === 'symlink');
    expect(query).not.toHaveBeenCalled();
  });
  it.each(['bad\n', 'x'.repeat(1025)])('sanitizes invalid/oversized socket requests', async payload => {
    stop = await startDevelopmentDiagnostic(`${root}/private`);
    expect(await invoke(`${root}/private/binding.sock`, payload)).toEqual({ status: 'BLOCKED', code: 'INVALID_REQUEST' });
    expect(query).not.toHaveBeenCalled();
  });
  it('bounds concurrency and ignores additional requests on a pending connection', async () => {
    let resolve!: (value: any) => void;
    query.mockImplementation(() => new Promise(r => { resolve = r; }));
    stop = await startDevelopmentDiagnostic(`${root}/private`);
    const first = invoke(`${root}/private/binding.sock`, JSON.stringify(expected) + '\n');
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    expect(await invoke(`${root}/private/binding.sock`)).toEqual({ status: 'BLOCKED', code: 'BUSY' });
    resolve({ rows: [{ database_match: true, role_match: true, cluster_match: true, endpoint_match: true }] });
    expect((await first).status).toBe('PASS'); expect(query).toHaveBeenCalledOnce();
  });
  it('has no HTTP diagnostic even in development', async () => {
    const app = createApp();
    try { await request(app).post('/api/admin/diagnostics/database-binding').send(expected).expect(404); }
    finally { app.locals.stopAbuseProtection(); }
    expect(query).not.toHaveBeenCalled();
  });
  it.each([{ status: 'PASS', checks: {}, secret: 'leak' }, { status: 'BLOCKED', code: 'untrusted remote message' }, { status: 'PASS', checks: { database_match: 'FAIL', role_match: 'PASS', cluster_match: 'PASS', endpoint_match: 'PASS' } }])('rejects injected or inconsistent remote results', body => {
    expect(safeResponse(body)).toEqual({ status: 'BLOCKED', code: 'INVALID_RESPONSE' });
  });
  it('executes the actual built-in-only SSH client against the existing private listener', async () => {
    stop = await startDevelopmentDiagnostic();
    const { stdout, stderr } = await exec(process.execPath, ['scripts/ci/invoke-dev-pool.cjs', ...Object.values(expected)]);
    expect(stderr).toBe(''); expect(JSON.parse(stdout).status).toBe('PASS');
    expect(query).toHaveBeenCalledOnce();
  });
  it('client without a running socket blocks without constructing a Pool', async () => {
    const { stdout, stderr } = await exec(process.execPath, ['scripts/ci/invoke-dev-pool.cjs', ...Object.values(expected)]);
    expect(stderr).toBe(''); expect(JSON.parse(stdout)).toEqual({ status: 'BLOCKED', code: 'PRIVATE_DIAGNOSTIC_UNAVAILABLE' });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    { raw: 'password=secret', ssh: '0', code: 'SSH_OR_PROTOCOL_UNAVAILABLE' },
    { raw: JSON.stringify({ status: 'BLOCKED', code: 'private host password' }), ssh: '0', code: 'INVALID_RESPONSE' },
    { raw: JSON.stringify({ status: 'PASS', checks: { database_match: 'PASS', role_match: 'PASS', cluster_match: 'PASS', endpoint_match: 'PASS' } }), ssh: '255', code: 'SSH_OR_PROTOCOL_UNAVAILABLE' },
  ])('local renderer withholds raw remote output and rejects transport errors', async ({ raw, ssh, code }) => {
    await writeFile(`${root}/raw`, raw);
    let output = '';
    try { await exec(process.execPath, ['scripts/ci/render-dev-pool.cjs', `${root}/raw`, `${root}/report`, ssh]); }
    catch (error) { output = (error as { stdout: string }).stdout; }
    const body = { status: 'BLOCKED', code };
    expect(JSON.parse(output)).toEqual(body);
    expect(JSON.parse(await readFile(`${root}/report`, 'utf8'))).toEqual(body);
  });
  it('workflow is manual main-only, uses DEV vars, SSH and private client without deployment actions', async () => {
    const yaml = await readFile('.github/workflows/verify-dev-pool-binding.yml', 'utf8');
    for (const text of ['workflow_dispatch:', "github.ref == 'refs/heads/main'", 'group: dev-deploy', 'cancel-in-progress: false', 'vars.DEV_PG_SYSTEM_IDENTIFIER', 'vars.DEV_PG_SERVER_ADDR', 'vars.DEV_PG_SERVER_PORT', 'secrets.DEPLOY_SSH_KEY', 'secrets.DEV_SSH_KNOWN_HOSTS', 'scripts/ci/invoke-dev-pool.cjs', 'scripts/ci/render-dev-pool.cjs']) expect(yaml).toContain(text);
    expect(yaml).not.toMatch(/ssh-keyscan|systemctl|sudo|import-geonames|npm run migrate|workflow_call|pull_request:/);
    const client = await readFile('scripts/ci/invoke-dev-pool.cjs', 'utf8');
    expect(client).not.toMatch(/require\(['"](?:pg|dotenv)|DATABASE_URL|\/proc/);
  });
});
