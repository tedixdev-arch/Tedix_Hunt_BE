import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

const importFreshEnvironmentModule = async () => {
  vi.resetModules();
  return import('./config/environment.js');
};

describe('TedixHunt API', () => {
  const app = createApp();

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('uses safe local defaults for API host and port', async () => {
    vi.unstubAllEnvs();

    const { readEnvironment } = await importFreshEnvironmentModule();

    expect(readEnvironment()).toMatchObject({
      host: '127.0.0.1',
      port: 3001,
    });
  });

  it('uses a configured API host and port', async () => {
    vi.stubEnv('API_HOST', 'api-private.internal');
    vi.stubEnv('API_PORT', '4100');

    const { readEnvironment } = await importFreshEnvironmentModule();

    expect(readEnvironment()).toMatchObject({
      host: 'api-private.internal',
      port: 4100,
    });
  });

  it('rejects invalid API host configuration', async () => {
    vi.stubEnv('API_HOST', 'https://example.invalid/api');
    vi.stubEnv('API_PORT', '3001');

    await expect(importFreshEnvironmentModule()).rejects.toThrow(
      /Invalid API_HOST/,
    );
  });

  it('rejects invalid API port configuration', async () => {
    vi.stubEnv('API_HOST', '127.0.0.1');
    vi.stubEnv('API_PORT', '70000');

    await expect(importFreshEnvironmentModule()).rejects.toThrow(
      /Invalid API_PORT/,
    );
  });

  it('returns HTTP 200 for the root health endpoint', async () => {
    await request(app).get('/health').expect(200);
  });

  it('returns HTTP 200 for the API health endpoint', async () => {
    await request(app).get('/api/health').expect(200);
  });

  it('returns the expected health contract', async () => {
    const response = await request(app).get('/api/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'tedixhunt-api',
      version: expect.any(String),
    });
    expect(new Date(response.body.timestamp).toISOString()).toBe(
      response.body.timestamp,
    );
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const response = await request(app)
      .get('/unknown-route')
      .expect(404)
      .expect('Content-Type', /json/);

    expect(response.body).toMatchObject({
      error: 'not_found',
    });
  });

  it('does not expose internal error details in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const productionApp = createApp({ includeErrorProbe: true });

    const response = await request(productionApp)
      .get('/__error-probe')
      .expect(500)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      error: 'internal_server_error',
      message: 'An unexpected error occurred.',
    });
    expect(JSON.stringify(response.body)).not.toContain('sensitive');
  });
});
