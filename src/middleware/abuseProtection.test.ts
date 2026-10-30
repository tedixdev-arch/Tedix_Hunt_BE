import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAbuseProtectionConfig, type AbuseProtectionConfig } from '../config/abuseProtection.js';
import { createAbuseProtection, networkIdentity, TokenBuckets } from './abuseProtection.js';

const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach((stop) => stop()); vi.useRealTimers(); });
const config = () => ({ ...readAbuseProtectionConfig({}), enabled: true });
function fixture(options: AbuseProtectionConfig = config()) {
  let now = 0;
  const app = express();
  app.set('trust proxy', options.trustedProxies.length ? options.trustedProxies : false);
  const limiter = createAbuseProtection(options, () => now);
  stops.push(limiter.stop);
  app.use(limiter.middleware, express.json(), limiter.accountMiddleware);
  app.use((_req, res) => res.status(200).json({ ok: true }));
  return { app, limiter, advance: (ms: number) => { now += ms; } };
}
const login = (app: express.Express, email = 'one@example.invalid', path = '/api/auth/participant/login') =>
  request(app).post(path).send({ email, password: 'never-used' });

describe('bounded authentication abuse protection', () => {
  it('admits budget, returns meaningful retry and recovers with a deterministic clock', async () => {
    const c = config(); c.budgets.loginAccount = { capacity: 2, windowMs: 10_000 };
    const f = fixture(c);
    await login(f.app).expect(200); await login(f.app).expect(200);
    const denied = await login(f.app).expect(429);
    expect(denied.headers['retry-after']).toBe('5');
    expect(denied.body).toEqual({ error: 'too_many_requests' });
    f.advance(4_000);
    expect((await login(f.app).expect(429)).headers['retry-after']).toBe('1');
    f.advance(1_000); await login(f.app).expect(200);
  });
  it('independently budgets accounts across networks and all role login paths', async () => {
    const c = config(); c.trustedProxies = ['127.0.0.1/32', '::1/128'];
    c.budgets.loginAccount.capacity = 1;
    const f = fixture(c);
    await login(f.app, ' One@Example.invalid ').set('X-Forwarded-For', '192.0.2.1').expect(200);
    await login(f.app, 'one@example.invalid', '/api/auth/admin/login').set('X-Forwarded-For', '192.0.2.2').expect(429);
    await login(f.app, 'two@example.invalid').set('X-Forwarded-For', '192.0.2.2').expect(200);
  });
  it('username and role rotation cannot escape the network budget', async () => {
    const c = config(); c.budgets.loginNetwork.capacity = 2;
    const f = fixture(c);
    await login(f.app, 'a').expect(200);
    await login(f.app, 'b', '/api/auth/creator/login').expect(200);
    await login(f.app, 'c', '/API/AUTH/ORGANIZER/LOGIN/').expect(429);
  });
  it('admits forty shared-NAT guest joins in sixty seconds, then bounds abuse', async () => {
    const f = fixture();
    for (let i = 0; i < 40; i++) await request(f.app).post('/api/auth/guest').send({ clientId: `untrusted-${i}` }).expect(200);
    for (let i = 40; i < 80; i++) await request(f.app).post('/api/auth/guest').expect(200);
    await request(f.app).post('/api/auth/guest').send({ clientId: 'fresh' }).expect(429);
    f.advance(60_000); await request(f.app).post('/api/auth/guest').expect(200);
  });
  it('ignores forged forwarding headers from an untrusted socket', async () => {
    const c = config(); c.trustedProxies = ['192.0.2.0/24']; c.budgets.guest.capacity = 1;
    const f = fixture(c);
    await request(f.app).post('/api/auth/guest').set('X-Forwarded-For', '198.51.100.1').expect(200);
    await request(f.app).post('/api/auth/guest').set('X-Forwarded-For', '198.51.100.2').expect(429);
  });
  it('uses the nearest untrusted hop and ignores attacker-supplied leftmost addresses', async () => {
    const c = config(); c.trustedProxies = ['127.0.0.1/32', '::1/128']; c.budgets.guest.capacity = 1;
    const f = fixture(c);
    await request(f.app).post('/api/auth/guest').set('X-Forwarded-For', '203.0.113.1, 198.51.100.1').expect(200);
    await request(f.app).post('/api/auth/guest').set('X-Forwarded-For', '203.0.113.2, 198.51.100.1').expect(429);
    await request(f.app).post('/api/auth/guest').set('X-Forwarded-For', '198.51.100.2').expect(200);
  });
  it('shares registration/application budgets while keeping other categories separate', async () => {
    const c = config(); c.budgets.registration.capacity = 1; c.budgets.activation.capacity = 1; c.budgets.refresh.capacity = 1;
    const f = fixture(c);
    await request(f.app).post('/api/auth/participant/register').send({}).expect(200);
    for (const path of ['/api/organizer-applications', '/api/creator-applications']) {
      await request(f.app).post(path).send({}).expect(429);
    }
    await request(f.app).post('/api/auth/admin/activate').send({}).expect(200);
    for (const path of ['/api/auth/creator/activate', '/api/auth/organizer/activate-direct']) {
      await request(f.app).post(path).send({}).expect(429);
    }
    await request(f.app).post('/api/auth/refresh').send({}).expect(200);
    await request(f.app).post('/api/auth/refresh').send({ refreshToken: 'changed' }).expect(429);
    await request(f.app).post('/api/auth/guest').expect(200);
  });
  it('bounds malformed identity keys and budgets invalid JSON before parsing', async () => {
    const c = config(); c.budgets.loginNetwork.capacity = 3;
    const f = fixture(c);
    await request(f.app).post('/api/auth/participant/login').send({ email: {}, password: [] }).expect(400);
    await request(f.app).post('/api/auth/participant/login').send([]).expect(400);
    await request(f.app).post('/api/auth/participant/login').type('json').send('{').expect(400);
    await login(f.app).expect(429);
  });
  it('never limits logout, gameplay, role administration or preflight', async () => {
    const c = config(); c.maxEntries = 1; c.budgets.guest.capacity = 1;
    const f = fixture(c);
    await request(f.app).post('/api/auth/guest').expect(200);
    for (let i = 0; i < 3; i++) {
      for (const path of ['/api/auth/logout', '/api/hunts/one', '/api/admin/users/one/roles']) await request(f.app).post(path).expect(200);
      await request(f.app).options('/api/auth/guest').expect(200);
    }
  });
  it('disabled enforcement preserves downstream behavior and allocates no entries', async () => {
    const c = config(); c.enabled = false; c.maxEntries = 1;
    const f = fixture(c);
    for (let i = 0; i < 5; i++) await login(f.app).expect(200);
    await request(f.app).post('/api/auth/participant/register').send([]).expect(200);
    expect(f.limiter.store.size).toBe(0);
  });
  it('fails closed at capacity, retains active budgets and expires without traffic', () => {
    vi.useFakeTimers();
    let now = 0;
    const c = config(); c.maxEntries = 2;
    const limiter = createAbuseProtection(c, () => now); stops.push(limiter.stop);
    const budget = { capacity: 1, windowMs: 10_000 };
    expect(limiter.store.consume('one', budget)).toBe(0);
    expect(limiter.store.consume('two', budget)).toBe(0);
    for (let i = 0; i < 100; i++) expect(limiter.store.consume(`attack-${i}`, budget)).toBe(10);
    expect(limiter.store.size).toBe(2);
    expect(limiter.store.consume('one', budget)).toBe(10);
    now = 10_000; vi.advanceTimersByTime(1_000);
    expect(limiter.store.size).toBe(0);
    expect(limiter.store.consume('three', budget)).toBe(0);
  });
  it('reclaims expired entries immediately when full', () => {
    let now = 0; const buckets = new TokenBuckets(1, () => now);
    expect(buckets.consume('a', { capacity: 1, windowMs: 100 })).toBe(0);
    now = 100;
    expect(buckets.consume('b', { capacity: 1, windowMs: 100 })).toBe(0);
    expect(buckets.size).toBe(1);
  });
  it('canonicalizes mapped IPv4 and aggregates IPv6 /64 suffix rotation', () => {
    expect(networkIdentity('::ffff:192.0.2.1')).toBe(networkIdentity('192.0.2.1'));
    expect(networkIdentity('2001:db8:0:1::1')).toBe(networkIdentity('2001:0db8:0000:0001::abcd'));
    expect(networkIdentity('2001:db8:0:2::1')).not.toBe(networkIdentity('2001:db8:0:1::1'));
  });
  it('defaults off in production and rejects ambiguous or unsafe configuration', () => {
    expect(readAbuseProtectionConfig({ NODE_ENV: 'production' }).enabled).toBe(false);
    for (const AUTH_TRUSTED_PROXIES of ['true', '1', 'loopback', '', '0.0.0.0/0', '::/0', '192.0.2.1/33', 'bogus']) expect(() => readAbuseProtectionConfig({ AUTH_TRUSTED_PROXIES })).toThrow();
    for (const AUTH_ABUSE_GUEST_CAPACITY of ['0', '-1', 'NaN', '1.5', '1000001']) expect(() => readAbuseProtectionConfig({ AUTH_ABUSE_GUEST_CAPACITY })).toThrow();
    expect(() => readAbuseProtectionConfig({ AUTH_ABUSE_ENABLED: 'yes' })).toThrow();
    expect(readAbuseProtectionConfig({ AUTH_ABUSE_ENABLED: 'true', AUTH_ABUSE_GUEST_CAPACITY: '100' }).budgets.guest.capacity).toBe(100);
  });
});
