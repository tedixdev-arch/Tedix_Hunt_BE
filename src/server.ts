import 'dotenv/config';
import { createApp } from './app.js';
import { environment } from './config/environment.js';
import { connectPostgres, disconnectPostgres } from './lib/postgres.js';
import { createGracefulShutdown } from './lib/shutdown.js';

const start = async () => {
  await connectPostgres();

  const app = createApp();
  const server = app.listen(environment.port, environment.host, () => {
    console.log(`TedixHunt API listening on ${environment.host}:${environment.port}`);
  });

  const shutdown = createGracefulShutdown(server, disconnectPostgres);
  const handleSignal = (signal: NodeJS.Signals) => {
    console.log(`${signal} received. Shutting down TedixHunt API.`);
    void shutdown().catch((error: unknown) => {
      console.error('Failed to shut down TedixHunt API cleanly.', error);
      process.exit(1);
    });
  };

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);
};

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
