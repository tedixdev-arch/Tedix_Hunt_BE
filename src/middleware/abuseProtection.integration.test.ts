import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';
import { readAbuseProtectionConfig } from '../config/abuseProtection.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
suite('QA-02 enabled protection against disposable PostgreSQL', () => {
  const databaseName = `qa02_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let pool: Pool | undefined;
  let created = false;
  let createApp: typeof import('../app.js').createApp;
  const apps: ReturnType<typeof createApp>[] = [];
  let now = 0;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const filename of (await readdir(directory)).filter((name) => /^\d{3}_.*\.ts$/.test(name)).sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js');
    environment.databaseUrl = url.toString();
    pool = (await import('../lib/postgres.js')).pool;
    createApp = (await import('../app.js')).createApp;
  }, 30_000);
  afterAll(async () => {
    apps.forEach((app) => app.locals.stopAbuseProtection());
    await pool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });
  const appFor = (guestCapacity = 80) => {
    const config = { ...readAbuseProtectionConfig({}), enabled: true };
    config.budgets.guest.capacity = guestCapacity;
    const app = createApp({ abuseProtection: config, abuseClock: () => now });
    apps.push(app); return app;
  };
  it('persists 40 shared-IP guests, rejects at the configured boundary and recovers', async () => {
    const app = appFor(40);
    for (let i = 0; i < 40; i++) await request(app).post('/api/auth/guest').expect(201);
    expect((await db.query('SELECT count(*)::int AS n FROM users WHERE is_guest')).rows[0].n).toBe(40);
    const denied = await request(app).post('/api/auth/guest').expect(429);
    expect(denied.headers['retry-after']).toBe('2');
    expect((await db.query('SELECT count(*)::int AS n FROM users WHERE is_guest')).rows[0].n).toBe(40);
    now += 60_000; await request(app).post('/api/auth/guest').expect(201);
    expect((await db.query('SELECT count(*)::int AS n FROM users WHERE is_guest')).rows[0].n).toBe(41);
  });
  it('preserves registration, all four logins, rotation/replay, authorization and logout', async () => {
    const app = appFor();
    const email = `${randomUUID()}@example.invalid`, password = 'Disposable123!';
    const registered = await request(app).post('/api/auth/participant/register').send({ email, password, name: 'QA02' }).expect(201);
    const userId = registered.body.user.id;
    await request(app).get('/api/admin/users').set('Authorization', `Bearer ${registered.body.tokens.accessToken}`).expect(403);
    await request(app).get('/api/admin/users').expect(401);
    for (const role of ['organizer', 'creator', 'admin']) await db.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [userId, role]);
    for (const role of ['participant', 'organizer', 'creator', 'admin']) {
      const signedIn = await request(app).post(`/api/auth/${role}/login`).send({ email, password }).expect(200);
      expect(signedIn.body.user.id).toBe(userId);
      expect(signedIn.body.user.roles).toContain(role);
    }
    const original = registered.body.tokens.refreshToken;
    const rotated = await request(app).post('/api/auth/refresh').send({ refreshToken: original }).expect(200);
    expect(rotated.body.refreshToken).not.toBe(original);
    await request(app).post('/api/auth/refresh').send({ refreshToken: original }).expect(401, { error: 'invalid_refresh' });
    await request(app).post('/api/auth/logout').send({ refreshToken: rotated.body.refreshToken }).expect(200, { success: true });
    await request(app).post('/api/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
    await db.query("UPDATE users SET account_status='blocked' WHERE id=$1", [userId]);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${rotated.body.accessToken}`).expect(401);
    await request(app).post('/api/auth/admin/login').send({ email, password }).expect(401);
  });
});
