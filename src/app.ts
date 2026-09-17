import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import { environment } from './config/environment.js';
import { swaggerSpec } from './lib/swagger.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { organizationsRouter } from './routes/organizations.js';
import { huntsRouter } from './routes/hunts.js';

interface CreateAppOptions {
  includeErrorProbe?: boolean;
}

export const createApp = (options: CreateAppOptions = {}) => {
  const app = express();

  app.use(express.json());

  if (environment.webOrigin) {
    app.use(cors({ origin: environment.webOrigin }));
  }

  app.use('/health', healthRouter);
  app.use('/api/health', healthRouter);

  app.get('/api/ping', (_request, response) => {
    response.status(200).json({ pong: true, timestamp: new Date().toISOString() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/organizations', organizationsRouter);
  app.use('/api/hunts', huntsRouter);

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
    const message = error instanceof Error ? error.message : 'Unexpected error';
    const isPostgresError =
      typeof error === 'object' && error !== null && 'code' in error &&
      typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code);

    response.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected error occurred.',
      // PostgreSQL diagnostics may contain schema or connection details and are never public.
      ...(process.env.NODE_ENV === 'production' || isPostgresError ? {} : { detail: message }),
    });
  };

  app.use(errorHandler);

  return app;
};
