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
  it('separates one-token replenishment from full-window idle cleanup', () => {
    let now = 0;
    const buckets = new TokenBuckets(1, () => now);
    const budget = { capacity: 10, windowMs: 10_000 };
    expect(buckets.consume('one', budget)).toBe(0);
    expect(buckets.nextExpiry).toBe(10_000);
    now = 1_000; buckets.sweep();
    expect(buckets.size).toBe(1);
    // Exactly one token has returned; the balance legitimately is full again.
    for (let i = 0; i < 10; i++) expect(buckets.consume('one', budget)).toBe(0);
    expect(buckets.consume('one', budget)).toBe(1);
    expect(buckets.nextExpiry).toBe(11_000);
  });
  it('retains a partially depleted balance after one token-refill interval', () => {
    let now = 0; const buckets = new TokenBuckets(1, () => now);
    const budget = { capacity: 10, windowMs: 10_000 };
    for (let i = 0; i < 7; i++) expect(buckets.consume('one', budget)).toBe(0);
    now = 1_000; buckets.sweep();
    for (let i = 0; i < 4; i++) expect(buckets.consume('one', budget)).toBe(0);
    expect(buckets.consume('one', budget)).toBe(1);
  });
  it('does not issue fresh bursts to repeated or continuously active requests', () => {
    let now = 0; const buckets = new TokenBuckets(1, () => now);
    const budget = { capacity: 5, windowMs: 10_000 };
    let accepted = 0;
    for (let step = 0; step <= 100; step++) {
      now = step * 500; buckets.sweep();
      for (let burst = 0; burst < 10; burst++) {
        if (buckets.consume('active', budget) === 0) accepted++;
      }
      expect(accepted).toBe(5 + Math.floor(now / 2_000));
      expect(buckets.size).toBe(1);
      expect(buckets.nextExpiry).toBe(now + 10_000);
    }
  });
  it('automatically removes a replenished idle bucket only after its idle deadline', () => {
    vi.useFakeTimers();
    let now = 0;
    const c = config(); c.maxEntries = 1;
    const limiter = createAbuseProtection(c, () => now); stops.push(limiter.stop);
    limiter.store.consume('one', { capacity: 10, windowMs: 10_000 });
    now = 1_000; vi.advanceTimersByTime(1_000);
    expect(limiter.store.size).toBe(1);
    now = 9_999; vi.advanceTimersByTime(1_000);
    expect(limiter.store.size).toBe(1);
    now = 10_000; vi.advanceTimersByTime(1_000);
    expect(limiter.store.size).toBe(0);
    expect(limiter.store.nextExpiry).toBe(Infinity);
  });
  it('keeps the earliest deadline exact after updates, rejections and expiry', () => {
    let now = 0; const buckets = new TokenBuckets(2, () => now);
    const budget = { capacity: 2, windowMs: 4_000 };
    buckets.consume('a', budget);
    now = 1_000; buckets.consume('b', budget);
    expect(buckets.nextExpiry).toBe(4_000);
    now = 2_000; buckets.consume('a', budget);
    expect(buckets.nextExpiry).toBe(5_000);
    now = 5_000; buckets.sweep();
    expect(buckets.size).toBe(1);
    expect(buckets.nextExpiry).toBe(6_000);
    expect(buckets.consume('a', budget)).toBe(0);
    expect(buckets.nextExpiry).toBe(9_000);
    now = 5_500; expect(buckets.consume('a', budget)).toBe(0);
    expect(buckets.consume('a', budget)).toBe(2);
    expect(buckets.nextExpiry).toBe(9_500);
    now = 9_500; buckets.sweep();
    expect(buckets.nextExpiry).toBe(Infinity);
  });
  it('reclaims expired entries without resetting active budgets under capacity pressure', () => {
    let now = 0; const buckets = new TokenBuckets(2, () => now);
    const budget = { capacity: 2, windowMs: 4_000 };
    buckets.consume('idle', budget);
    buckets.consume('active', budget); buckets.consume('active', budget);
    now = 1_000;
    expect(buckets.consume('active', budget)).toBe(1);
    expect(buckets.nextExpiry).toBe(4_000);
    now = 4_000;
    expect(buckets.consume('new', budget)).toBe(0);
    expect(buckets.size).toBe(2);
    expect(buckets.nextExpiry).toBe(5_000);
    // Active has two replenished tokens, not more; capacity admission cannot reset it.
    expect(buckets.consume('active', budget)).toBe(0);
    expect(buckets.consume('active', budget)).toBe(0);
    expect(buckets.consume('active', budget)).toBe(2);
    expect(buckets.nextExpiry).toBe(8_000);
    for (let i = 0; i < 1_000; i++) expect(buckets.consume(`attack-${i}`, budget)).toBe(4);
    expect(buckets.size).toBe(2);
    expect(buckets.nextExpiry).toBe(8_000);
  });
  it('does not repeatedly sweep live entries during capacity floods after a deadline moves', () => {
    let now = 0; const buckets = new TokenBuckets(1, () => now);
    const budget = { capacity: 2, windowMs: 10_000 };
    buckets.consume('active', budget);
    now = 1_000; buckets.consume('active', budget);
    now = 10_000;
    const sweeps = vi.spyOn(buckets, 'sweep');
    for (let i = 0; i < 1_000; i++) expect(buckets.consume(`attack-${i}`, budget)).toBe(1);
    expect(sweeps).not.toHaveBeenCalled();
    expect(buckets.size).toBe(1);
    expect(buckets.nextExpiry).toBe(11_000);
    now = 11_000;
    expect(buckets.consume('new', budget)).toBe(0);
    expect(buckets.nextExpiry).toBe(21_000);
  });
  it('keeps HTTP Retry-After accurate during repeated denials without postponing refill', async () => {
    const c = config(); c.budgets.guest = { capacity: 2, windowMs: 10_000 };
    const f = fixture(c);
    await request(f.app).post('/api/auth/guest').expect(200);
    await request(f.app).post('/api/auth/guest').expect(200);
    f.advance(1_000); f.limiter.store.sweep();
    expect((await request(f.app).post('/api/auth/guest').expect(429)).headers['retry-after']).toBe('4');
    f.advance(3_001); f.limiter.store.sweep();
    expect((await request(f.app).post('/api/auth/guest').expect(429)).headers['retry-after']).toBe('1');
    f.advance(999); await request(f.app).post('/api/auth/guest').expect(200);
    expect((await request(f.app).post('/api/auth/guest').expect(429)).headers['retry-after']).toBe('5');
  });
  it('matches a simple reference model across mixed budgets, heap updates and reclamation', () => {
    let now = 0;
    const buckets = new TokenBuckets(8, () => now);
    const model = new Map<string, { tokens: number; updatedAt: number; expiresAt: number }>();
    for (let step = 0; step < 2_000; step++) {
      now += (step * 7 % 5) * 250;
      const id = step * 11 % 17, key = `id-${id}`;
      const capacity = 2 ** (1 + id % 3), windowMs = capacity * 1_000;
      for (const [id, entry] of model) if (entry.expiresAt <= now) model.delete(id);
      let entry = model.get(key), expected: number;
      if (!entry && model.size === 8) {
        expected = Math.max(1, Math.ceil((Math.min(...[...model.values()].map((e) => e.expiresAt)) - now) / 1_000));
      } else {
        if (!entry) { entry = { tokens: capacity, updatedAt: now, expiresAt: 0 }; model.set(key, entry); }
        entry.tokens = Math.min(capacity, entry.tokens + (now - entry.updatedAt) / 1_000);
        entry.updatedAt = now; entry.expiresAt = now + windowMs;
        if (entry.tokens >= 1) { entry.tokens--; expected = 0; }
        else expected = Math.max(1, Math.ceil((1 - entry.tokens)));
      }
      expect(buckets.consume(key, { capacity, windowMs })).toBe(expected);
      expect(buckets.size).toBe(model.size);
      // The expiry index must be bounded too, including repeated deadline extensions.
      expect(Reflect.get(buckets, 'deadlines')).toHaveLength(model.size);
      expect(buckets.nextExpiry).toBe(Math.min(...[...model.values()].map((e) => e.expiresAt)));
    }
    now += 100_000; buckets.sweep();
    expect(buckets.size).toBe(0); expect(buckets.nextExpiry).toBe(Infinity);
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
