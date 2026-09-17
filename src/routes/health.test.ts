import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ ready: vi.fn() }));
vi.mock('../lib/readiness.js', () => ({ checkDatabaseReadiness: mocks.ready }));
vi.mock('../lib/build-info.js', () => ({ readBuildRevision: () => 'a'.repeat(40) }));
import { createApp } from '../app.js';

describe('deployment health', () => {
  const app = createApp();
  beforeEach(() => { mocks.ready.mockReset(); });

  it.each(['/health', '/api/health'])('reports the deployed revision without querying the database at %s', async (path) => {
    const response = await request(app).get(path).expect(200);
    expect(response.body.revision).toBe('a'.repeat(40));
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mocks.ready).not.toHaveBeenCalled();
  });

  it.each(['/health/ready', '/api/health/ready'])('checks the database at %s', async (path) => {
    mocks.ready.mockResolvedValue(undefined);
    const response = await request(app).get(path).expect(200);
    expect(response.body).toEqual({ status: 'ok', database: 'ok', revision: 'a'.repeat(40) });
    expect(mocks.ready).toHaveBeenCalledOnce();
  });

  it('returns a noncached 503 without sensitive details while liveness remains available', async () => {
    mocks.ready.mockRejectedValue(new Error('postgresql://private:secret@internal/production'));
    const response = await request(app).get('/api/health/ready').expect(503);
    expect(response.body).toEqual({ status: 'unavailable', database: 'unavailable', revision: 'a'.repeat(40) });
    expect(response.headers['cache-control']).toBe('no-store');
    await request(app).get('/api/health').expect(200);
  });
});
