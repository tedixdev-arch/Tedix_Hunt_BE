import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import * as auth from '../services/auth.js';
import { environment } from '../config/environment.js';

describe('Authentication request boundary', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it.each(['register', 'login', 'refresh', 'logout'])('requires a CSRF header for %s', async (path) => {
    await request(createApp()).post(`/api/auth/${path}`).send({}).expect(403);
  });
  it('rejects untrusted origins even with the custom header', async () => {
    vi.stubEnv('WEB_ORIGIN', 'https://tedixhunt.example');
    await request(createApp()).post('/api/auth/refresh').set('X-TedixHunt-CSRF', '1').set('Origin', 'https://attacker.example').send({}).expect(403);
  });
  it.each([{}, [], { email: 'invalid', password: 'long test password' }, { email: 'a@b.test', password: 'short' }, { email: 'a@b.test', password: 'x'.repeat(129) }, { email: 'a@b.test', password: 'long test password', role: 'admin' }, { email: 'a@b.test', password: 'long test password', displayName: [] }])('rejects malformed registration: %j', async (body) => {
    await request(createApp()).post('/api/auth/register').set('X-TedixHunt-CSRF', '1').send(body).expect(400);
  });
  it('rejects malformed JSON safely', async () => {
    const result = await request(createApp()).post('/api/auth/login').set('Content-Type', 'application/json').send('{private').expect(400);
    expect(JSON.stringify(result.body)).not.toContain('private');
  });
  it.each(['', 'Bearer invalid', 'Bearer ' + 'x'.repeat(44)])('rejects malformed bearer credentials', async (header) => {
    await request(createApp()).get('/api/auth/me').set('Authorization', header).expect(401);
  });
  it('does not accept a refresh token from JSON instead of the cookie', async () => {
    await request(createApp()).post('/api/auth/refresh').set('X-TedixHunt-CSRF', '1').send({ refreshToken: 'x'.repeat(43) }).expect(401);
  });
  it('throttles account attempts', async () => {
    const app = createApp();
    for (let count = 0; count < 10; count++) await request(app).post('/api/auth/login').set('X-TedixHunt-CSRF', '1').send({}).expect(400);
    await request(app).post('/api/auth/login').set('X-TedixHunt-CSRF', '1').send({}).expect(429);
  });
  it('does not leak storage errors', async () => {
    vi.spyOn(auth, 'login').mockRejectedValue(new Error('private database credentials'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await request(createApp()).post('/api/auth/login').set('X-TedixHunt-CSRF', '1').send({ email: 'a@b.test', password: 'valid test password' }).expect(503);
    expect(response.body).toEqual({ error: 'service_unavailable', message: 'Authentication is temporarily unavailable.' });
  });
  it('permits credentialed CORS only for the configured frontend', async () => {
    const original = environment.webOrigin;
    environment.webOrigin = 'https://tedixhunt.example';
    try {
      const app = createApp();
      const allowed = await request(app).options('/api/auth/refresh').set('Origin', environment.webOrigin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'X-TedixHunt-CSRF').expect(204);
      expect(allowed.headers['access-control-allow-origin']).toBe(environment.webOrigin);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');
      const denied = await request(app).options('/api/auth/refresh').set('Origin', 'https://attacker.example').set('Access-Control-Request-Method', 'POST').expect(204);
      expect(denied.headers['access-control-allow-origin']).not.toBe('https://attacker.example');
    } finally { environment.webOrigin = original; }
  });
  it.each(['/api/auth/guest', '/api/auth/participant/login', '/api/auth/creator/login'])('retires mockup-era authentication: %s', async (path) => {
    await request(createApp()).post(path).set('X-TedixHunt-CSRF', '1').send({}).expect(404);
  });
});
