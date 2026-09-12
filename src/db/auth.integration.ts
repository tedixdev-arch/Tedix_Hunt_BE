import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { disconnectPostgres } from '../lib/postgres.js';
import { tokenHash } from '../services/auth.js';
import { verifyPassword } from '../lib/password.js';

export const authenticationTests = (pool: Pool, url: string) => describe('PostgreSQL authentication', () => {
  const password = 'a strong test password 123!';
  let previousUrl: string | undefined;
  const ids: string[] = [];
  const cookie = (response: request.Response) => (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const post = (app: ReturnType<typeof createApp>, path: string) => request(app).post(`/api/auth/${path}`).set('X-TedixHunt-CSRF', '1');
  let sequence = 0;
  const register = async (app: ReturnType<typeof createApp>) => {
    const email = `auth-${Date.now()}-${++sequence}@example.test`;
    const response = await post(app, 'register').send({ email, password, displayName: ' Tester ' }).expect(201);
    ids.push(response.body.user.id);
    return { response, email };
  };
  beforeAll(() => { previousUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = url; });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
    await disconnectPostgres();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  });

  it('registers a persisted user, stores hashes only, and restores identity with /me', async () => {
    const app = createApp();
    const { response } = await register(app);
    expect(response.body.user.displayName).toBe('Tester');
    expect(response.body.refreshToken).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('password');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Strict');
    const user = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [response.body.user.id])).rows[0];
    expect(await verifyPassword(password, user.password_hash)).toBe(true);
    const session = (await pool.query('SELECT access_hash FROM auth_sessions WHERE user_id = $1', [response.body.user.id])).rows[0];
    expect(session.access_hash).toBe(tokenHash(response.body.accessToken));
    const refreshHash = (await pool.query('SELECT token_hash FROM auth_refresh_tokens WHERE session_id IN (SELECT id FROM auth_sessions WHERE user_id = $1)', [response.body.user.id])).rows[0].token_hash;
    expect(refreshHash).toBe(tokenHash(cookie(response).split('=')[1]));
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${response.body.accessToken}`).expect(200);
    expect(me.body).toEqual({ user: response.body.user });
  });

  it('logs in case-insensitively and rejects wrong, unknown and passwordless credentials equally', async () => {
    const app = createApp();
    const { response, email } = await register(app);
    await post(app, 'login').send({ email: ` ${email.toUpperCase()} `, password }).expect(200);
    const wrong = await post(app, 'login').send({ email, password: 'incorrect password' }).expect(401);
    const missing = await post(app, 'login').send({ email: 'absent@example.test', password }).expect(401);
    await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [response.body.user.id]);
    const noPassword = await post(app, 'login').send({ email, password }).expect(401);
    expect(wrong.body).toEqual(missing.body);
    expect(noPassword.body).toEqual(missing.body);
  });

  it('rejects duplicate registration without creating extra users or sessions', async () => {
    const app = createApp();
    const { response, email } = await register(app);
    await post(app, 'register').send({ email: email.toUpperCase(), password }).expect(409);
    expect((await pool.query('SELECT count(*) FROM auth_sessions WHERE user_id = $1', [response.body.user.id])).rows[0].count).toBe('1');
  });

  it('rotates both tokens, rejects old access, and revokes the session on refresh reuse', async () => {
    const app = createApp();
    const { response } = await register(app);
    const rotated = await post(app, 'refresh').set('Cookie', cookie(response)).send({}).expect(200);
    expect(rotated.body.accessToken).not.toBe(response.body.accessToken);
    expect(cookie(rotated)).not.toBe(cookie(response));
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${response.body.accessToken}`).expect(401);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${rotated.body.accessToken}`).expect(200);
    await post(app, 'refresh').set('Cookie', cookie(response)).send({}).expect(401);
    await post(app, 'refresh').set('Cookie', cookie(rotated)).send({}).expect(401);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${rotated.body.accessToken}`).expect(401);
  });

  it('serializes simultaneous refreshes and revokes a reused session', async () => {
    const app = createApp();
    const { response } = await register(app);
    const results = await Promise.all([post(app, 'refresh').set('Cookie', cookie(response)).send({}), post(app, 'refresh').set('Cookie', cookie(response)).send({})]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const success = results.find((r) => r.status === 200)!;
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${success.body.accessToken}`).expect(401);
  });

  it('expires access independently, permits refresh, and enforces absolute session expiry', async () => {
    const app = createApp();
    const { response } = await register(app);
    await pool.query("UPDATE auth_sessions SET access_expires_at = CURRENT_TIMESTAMP - interval '1 second' WHERE user_id = $1", [response.body.user.id]);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${response.body.accessToken}`).expect(401);
    const rotated = await post(app, 'refresh').set('Cookie', cookie(response)).send({}).expect(200);
    await pool.query("UPDATE auth_sessions SET expires_at = CURRENT_TIMESTAMP - interval '1 second' WHERE user_id = $1", [response.body.user.id]);
    await post(app, 'refresh').set('Cookie', cookie(rotated)).send({}).expect(401);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${rotated.body.accessToken}`).expect(401);
  });

  it('logs out idempotently, clears the cookie and immediately invalidates access and refresh', async () => {
    const app = createApp();
    const { response } = await register(app);
    const result = await post(app, 'logout').set('Cookie', cookie(response)).send({}).expect(204);
    expect(result.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${response.body.accessToken}`).expect(401);
    await post(app, 'refresh').set('Cookie', cookie(response)).send({}).expect(401);
    await post(app, 'logout').set('Cookie', cookie(response)).send({}).expect(204);
  });

  it('supports bearer logout and isolates separate login sessions', async () => {
    const app = createApp();
    const { response, email } = await register(app);
    const second = await post(app, 'login').send({ email, password }).expect(200);
    await post(app, 'logout').set('Authorization', `Bearer ${response.body.accessToken}`).send({}).expect(204);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${response.body.accessToken}`).expect(401);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${second.body.accessToken}`).expect(200);
  });

  it('uses secure host-only cookies in production', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { response } = await register(createApp());
      expect(response.headers['set-cookie'][0]).toMatch(/^__Host-tedixhunt_refresh=/);
      expect(response.headers['set-cookie'][0]).toContain('Secure');
      expect(response.headers['set-cookie'][0]).toContain('Path=/');
      expect(response.headers['set-cookie'][0]).not.toContain('Domain=');
    } finally { process.env.NODE_ENV = original; }
  });
});
