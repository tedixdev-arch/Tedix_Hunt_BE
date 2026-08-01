import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { environment } from './config/environment.js';
import { healthRouter } from './routes/health.js';

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

    response.status(500).json({
      error: 'internal_server_error',
      message: 'An unexpected error occurred.',
      ...(process.env.NODE_ENV === 'production' ? {} : { detail: message }),
    });
  };

  app.use(errorHandler);

  return app;
};
