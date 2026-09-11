import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { checkPostgres } from '../lib/postgres.js';

vi.mock('../lib/postgres.js', () => ({ checkPostgres: vi.fn() }));

describe('PostgreSQL readiness', () => {
  afterEach(() => vi.resetAllMocks());
  it.each(['/health/ready', '/api/health/ready'])('reports a reachable database at %s', async (path) => {
    vi.mocked(checkPostgres).mockResolvedValue(undefined);
    const response = await request(createApp()).get(path).expect(200);
    expect(response.body).toEqual({ status: 'ok', database: 'up' });
  });
  it('reports 503 without database error details, while liveness stays up', async () => {
    vi.mocked(checkPostgres).mockRejectedValue(new Error('postgresql://private:secret@host/db'));
    const app = createApp();
    const response = await request(app).get('/api/health/ready').expect(503);
    expect(response.body).toEqual({ status: 'unavailable', database: 'down' });
    await request(app).get('/api/health').expect(200);
  });
  it.each(['/api/auth/guest', '/api/organizations'])('isolates disconnected legacy routes: %s', async (path) => {
    const response = await request(createApp()).post(path).send({}).expect(503);
    expect(response.body.error).toBe('service_unavailable');
  });
});
