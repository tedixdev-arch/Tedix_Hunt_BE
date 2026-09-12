import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import { environment } from './config/environment.js';
import { swaggerSpec } from './lib/swagger.js';
import { healthRouter } from './routes/health.js';
import { createAuthRouter } from './routes/auth.js';
import { organizationsRouter } from './routes/organizations.js';
import { requireLegacyMongo } from './lib/mongo.js';

interface CreateAppOptions {
  includeErrorProbe?: boolean;
}

export const createApp = (options: CreateAppOptions = {}) => {
  const app = express();

  app.use(express.json());

  if (environment.webOrigin) {
    app.use(cors({ origin: environment.webOrigin, credentials: true }));
  }

  app.use('/health', healthRouter);
  app.use('/api/health', healthRouter);

  app.use('/api/auth', createAuthRouter());
  app.use('/api/organizations', requireLegacyMongo, organizationsRouter);

  app.get('/api/docs.json', (_request, response) => {
    response.json(swaggerSpec);
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  if (options.includeErrorProbe) {
    app.get('/__error-probe', () => {
      throw new Error('sensitive internal detail');
    });
  }

  app.use((request, response) => {
    response.status(404).json({
      error: 'not_found',
      message: `Route ${request.method} ${request.path} was not found.`,
    });
  });

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
      response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'invalid_input', message: 'Invalid JSON request body.' });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unexpected error';

    response.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected error occurred.',
      ...(process.env.NODE_ENV === 'production' ? {} : { detail: message }),
    });
  };

  app.use(errorHandler);

  return app;
};
