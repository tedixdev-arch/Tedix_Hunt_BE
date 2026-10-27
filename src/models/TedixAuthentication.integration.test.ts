import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

// Supplied URL is used only to create a unique disposable database, never reset it.
const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `tedix_auth_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;

suite('unverified Tedix authentication against PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let pool: Pool | undefined;
  let created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(testUrl!);
    url.pathname = `/${databaseName}`;
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
    app = (await import('../app.js')).createApp();
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  const fixture = async (roles = ['participant'], status = 'active') => {
    const email = `d02-${randomUUID()}@example.invalid`;
    const tedixId = randomUUID();
    const user = (await db.query(
      `INSERT INTO users (email, password_hash, role, tedix_user_id, account_status)
       VALUES ($1, $2, 'participant', $3, $4) RETURNING *`,
      [email, await bcrypt.hash('Disposable123!', 4), tedixId, status],
    )).rows[0];
    for (const role of roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [user.id, role]);
    await db.query("INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [user.id, randomUUID()]);
    return user;
  };
  const snapshot = async () => Promise.all(
    ['users', 'user_roles', 'refresh_tokens', 'professional_activation_tokens'].map(async (table) =>
      (await db.query(`SELECT * FROM ${table} ORDER BY 1, 2`)).rows),
  );

  for (const endpoint of ['login', 'register']) {
    it.each([
      { label: 'arbitrary ID', unknown: true },
      { label: 'unknown ID', unknown: true },
      { label: 'existing linked ID' },
      { label: 'multi-role linked identity', roles: ['participant', 'creator', 'organizer', 'admin'] },
      { label: 'blocked linked account', status: 'blocked' },
      { label: 'retired linked account', status: 'retired' },
    ])(`${endpoint}: rejects $label and preserves all identities, roles and sessions`, async (scenario) => {
      const user = await fixture(scenario.roles, scenario.status);
      const before = await snapshot();
      const tedixUserId = scenario.unknown ? randomUUID() : user.tedix_user_id;
      // Replayed/forged assertions and authenticated native credentials cannot enable linking.
      for (const extra of [{}, { email: user.email, password: 'Disposable123!', assertion: 'forged', token: 'replayed' }]) {
        const response = await request(app).post(`/api/auth/participant/${endpoint}`)
          .send({ tedixUserId, ...extra }).expect(401);
        expect(response.body).toEqual({ error: 'unverified_tedix_identity' });
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(await snapshot()).toEqual(before);
      }
    });
  }

  it('preserves native linked-account logins, refresh rotation, logout and session invalidation', async () => {
    const user = await fixture(['participant', 'creator', 'organizer', 'admin']);
    for (const role of ['participant', 'creator', 'organizer', 'admin']) {
      const login = await request(app).post(`/api/auth/${role}/login`)
        .send({ email: user.email, password: 'Disposable123!' }).expect(200);
      expect(login.body.user.id).toBe(user.id);
      expect(login.body.user.tedixUserId).toBe(user.tedix_user_id);
      const original = login.body.tokens.refreshToken;
      const rotated = await request(app).post('/api/auth/refresh').send({ refreshToken: original }).expect(200);
      expect(rotated.body.accessToken).toEqual(expect.any(String));
      expect(rotated.body.refreshToken).not.toBe(original);
      await request(app).post('/api/auth/refresh').send({ refreshToken: original }).expect(401);
      await request(app).post('/api/auth/logout').send({ refreshToken: rotated.body.refreshToken }).expect(200);
      await request(app).post('/api/auth/logout').send({ refreshToken: rotated.body.refreshToken }).expect(200);
      await request(app).post('/api/auth/refresh').send({ refreshToken: rotated.body.refreshToken }).expect(401);
      expect((await db.query('SELECT id FROM refresh_tokens WHERE token IN ($1, $2)', [original, rotated.body.refreshToken])).rows).toEqual([]);
    }
  });

  it.each(['blocked', 'retired'])('preserves %s restrictions on native login, refresh and access', async (status) => {
    const user = await fixture(['participant', 'creator', 'organizer', 'admin']);
    const login = await request(app).post('/api/auth/participant/login')
      .send({ email: user.email, password: 'Disposable123!' }).expect(200);
    await db.query('UPDATE users SET account_status = $2 WHERE id = $1', [user.id, status]);
    for (const role of ['participant', 'creator', 'organizer', 'admin']) {
      await request(app).post(`/api/auth/${role}/login`)
        .send({ email: user.email, password: 'Disposable123!' }).expect(401);
    }
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.tokens.accessToken}`).expect(401);
    await request(app).post('/api/auth/refresh').send({ refreshToken: login.body.tokens.refreshToken }).expect(401);
  });

  it('preserves native registration and guest authentication without creating external links', async () => {
    const native = await request(app).post('/api/auth/participant/register')
      .send({ email: `native-${randomUUID()}@example.invalid`, password: 'Disposable123!' }).expect(201);
    expect(native.body.tokens.refreshToken).toEqual(expect.any(String));
    expect(native.body.user.tedixUserId).toBeNull();
    const guest = await request(app).post('/api/auth/guest').expect(201);
    expect(guest.body.tokens).toEqual({ accessToken: expect.any(String) });
    expect(guest.body.user.isGuest).toBe(true);
    expect(guest.body.user.tedixUserId).toBeNull();
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${guest.body.tokens.accessToken}`).expect(200);
    expect((await db.query('SELECT id FROM refresh_tokens WHERE user_id = $1', [guest.body.user.id])).rows).toEqual([]);
  });
});
