import { Router } from 'express';
import { environment } from '../config/environment.js';
import { readBuildRevision } from '../lib/build-info.js';
import { checkDatabaseReadiness } from '../lib/readiness.js';

export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
  version: string;
  revision: string | null;
}

export const healthRouter = Router();
const revision = readBuildRevision();

healthRouter.use((_request, response, next) => {
  response.set('Cache-Control', 'no-store');
  next();
});

healthRouter.get('/ready', async (_request, response) => {
  try {
    await checkDatabaseReadiness();
    response.status(200).json({ status: 'ok', database: 'ok', revision });
  } catch {
    // Public diagnostics must not expose credentials, server addresses or SQL errors.
    response.status(503).json({ status: 'unavailable', database: 'unavailable', revision });
  }
});

healthRouter.get('/', (_request, response) => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'tedixhunt-api',
    timestamp: new Date().toISOString(),
    version: environment.version,
    revision,
  };

  response.status(200).json(body);
});
