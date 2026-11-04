import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';

describe('Independent Organizer email codes', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('never returns a code unless a local machine explicitly opts in', async () => {
    vi.stubEnv('INDEPENDENT_ORGANIZER_DEV_CODES', '');
    const app = createApp();
    try {
      const response = await request(app).post('/api/auth/independent-organizer/request-code').send({ email: 'someone@example.com' }).expect(503);
      expect(response.body).toEqual({ error: 'email_delivery_unavailable' });
    } finally { app.locals.stopAbuseProtection(); }
  });

  it('rejects malformed requests before any lookup', async () => {
    const app = createApp();
    try {
      await request(app).post('/api/auth/independent-organizer/request-code').send({ email: 'not-an-email' }).expect(400);
      await request(app).post('/api/auth/independent-organizer/verify').send({ email: 'a@example.com', code: '12' }).expect(400);
    } finally { app.locals.stopAbuseProtection(); }
  });
});
