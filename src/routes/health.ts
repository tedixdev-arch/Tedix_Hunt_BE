import { Router } from 'express';
import { environment } from '../config/environment.js';
import { checkPostgres } from '../lib/postgres.js';

export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
  version: string;
}

export const healthRouter = Router();

healthRouter.get('/ready', async (_request, response) => {
  try {
    await checkPostgres();
    response.status(200).json({ status: 'ok', database: 'up' });
  } catch {
    response.status(503).json({ status: 'unavailable', database: 'down' });
  }
});

healthRouter.get('/', (_request, response) => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'tedixhunt-api',
    timestamp: new Date().toISOString(),
    version: environment.version,
  };

  response.status(200).json(body);
});
