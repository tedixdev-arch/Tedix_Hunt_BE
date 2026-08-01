import { Router } from 'express';
import { environment } from '../config/environment.js';

export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
  version: string;
}

export const healthRouter = Router();

healthRouter.get('/', (_request, response) => {
  const body: HealthResponse = {
    status: 'ok',
    service: 'tedixhunt-api',
    timestamp: new Date().toISOString(),
    version: environment.version,
  };

  response.status(200).json(body);
});
