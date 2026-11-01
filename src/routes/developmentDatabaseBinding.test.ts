import express from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), findById: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({ pool: { query: mocks.query } }));
vi.mock('../models/User.js', () => ({ User: { findById: mocks.findById } }));
import { developmentDatabaseBindingRouter } from './developmentDatabaseBinding.js';
import { environment } from '../config/environment.js';
import { signJwt } from '../lib/jwt.js';
import { createApp } from '../app.js';
const expected = { DEV_PG_SYSTEM_IDENTIFIER: '12345', DEV_PG_SERVER_ADDR: '127.0.0.1', DEV_PG_SERVER_PORT: '5432' };
const good = { database_match: true, role_match: true, cluster_match: true, endpoint_match: true };
const token = (payload = { sub: 'admin', type: 'access' }) => `Bearer ${signJwt(payload)}`;
const app = express();
app.use('/probe', developmentDatabaseBindingRouter);
const probe = () => request(app).post('/probe').set('Authorization', token());
const original = environment.nodeEnv;
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development'); environment.nodeEnv = 'development'; vi.clearAllMocks();
  mocks.findById.mockResolvedValue({ id: 'admin', roles: ['admin'], isGuest: false, accountStatus: 'active' });
  mocks.query.mockResolvedValue({ rows: [{ ...good }] });
});
afterEach(() => { vi.unstubAllEnvs(); environment.nodeEnv = original; });
describe('development Pool binding diagnostic', () => {
  it('uses existing Pool with one parameterized read-only SELECT and returns only checks', async () => {
    const r = await probe().send(expected).expect(200);
    expect(r.body).toEqual({ status: 'PASS', checks: Object.fromEntries(Object.keys(good).map(k => [k, 'PASS'])) });
    expect(mocks.query).toHaveBeenCalledOnce();
    const q = mocks.query.mock.calls[0][0];
    expect(q.values).toEqual(Object.values(expected));
    expect(q.text.trim()).toMatch(/^SELECT /);
    expect(q.text).toContain('pg_catalog.pg_control_system()');
    expect(q.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|GRANT|SET|CREATE)\b/);
    expect(q.query_timeout).toBe(5000);
  });
  it.each(Object.keys(good))('fails a %s mismatch', async key => {
    mocks.query.mockResolvedValue({ rows: [{ ...good, [key]: false }] });
    const r = await probe().send(expected).expect(200); expect(r.body.status).toBe('FAIL'); expect(r.body.checks[key]).toBe('FAIL');
  });
  it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ ...good, endpoint_match: null }] }])('blocks incomplete identity %j', async ({ rows }) => {
    mocks.query.mockResolvedValue({ rows }); expect((await probe().send(expected).expect(503)).body.status).toBe('BLOCKED');
  });
  it.each(['42501', '08006', undefined])('sanitizes all query failures %s', async code => {
    mocks.query.mockRejectedValue(Object.assign(new Error('postgres://secret:password@private/db'), { code }));
    const r = await probe().send(expected).expect(503);
    expect(r.body).toEqual({ status: 'BLOCKED', code: code === '42501' ? 'PERMISSION_PG_METADATA' : 'IDENTITY_UNAVAILABLE' });
  });
  it.each([{}, { ...expected, DEV_PG_SERVER_ADDR: 'hostname' }, { ...expected, DEV_PG_SERVER_PORT: '65536' }, { ...expected, extra: 'secret' }, { ...expected, DEV_PG_SYSTEM_IDENTIFIER: "1' OR true" }])('rejects invalid configuration', async body => {
    await probe().send(body).expect(400); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('requires a valid access credential', async () => {
    for (const auth of ['', 'Bearer invalid', token({ sub: 'admin', type: 'refresh' })]) {
      const r = await request(app).post('/probe').set('Authorization', auth).send(expected).expect(401);
      expect(r.body.status).toBe('BLOCKED');
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([{ roles: ['participant'] }, { roles: ['admin'], isGuest: true }, { accountStatus: 'blocked' }, { accountStatus: 'retired' }])('rejects unauthorized identity %j', async override => {
    mocks.findById.mockResolvedValue({ roles: ['admin'], isGuest: false, accountStatus: 'active', ...override });
    const r = await probe().send(expected); expect([401,403]).toContain(r.status); expect(r.body.status).toBe('BLOCKED'); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('rejects a non-loopback transport before authentication', async () => {
    const remote = express();
    remote.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.1' }); next(); });
    remote.use(developmentDatabaseBindingRouter);
    const r = await request(remote).post('/').set('Authorization', token()).send(expected).expect(403);
    expect(r.body).toEqual({ status: 'BLOCKED', code: 'DIRECT_LOOPBACK_REQUIRED' });
    expect(mocks.findById).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('requires explicit NODE_ENV even when captured environment defaults to development', async () => {
    vi.stubEnv('NODE_ENV', undefined);
    const r = await probe().send(expected).expect(404);
    expect(r.body.status).toBe('BLOCKED'); expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(['Forwarded', 'X-Forwarded-For', 'X-Forwarded-Proto'])('blocks forwarded requests %s', async header => {
    await probe().set(header, 'anything').send(expected).expect(403); expect(mocks.findById).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('sanitizes malformed and oversized JSON before the global development parser', async () => {
    for (const body of ['{secret:password', JSON.stringify({ secret: 'x'.repeat(2000) })]) {
      const full = createApp();
      try {
        const r = await request(full).post('/api/admin/diagnostics/database-binding').set('Authorization', token()).set('Content-Type', 'application/json').send(body).expect(400);
        expect(r.body).toEqual({ status: 'BLOCKED', code: 'INVALID_REQUEST' });
      } finally { full.locals.stopAbuseProtection(); }
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each(['production', 'test', ''])('does not register the route outside explicit development: %s', async env => {
    environment.nodeEnv = env; vi.stubEnv('NODE_ENV', env);
    const full = createApp();
    try { await request(full).post('/api/admin/diagnostics/database-binding').send(expected).expect(404); }
    finally { full.locals.stopAbuseProtection(); }
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
