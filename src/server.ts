import 'dotenv/config';
import { createApp } from './app.js';
import { environment } from './config/environment.js';
import { connectMongo, disconnectMongo } from './lib/mongo.js';
import { checkPostgres, disconnectPostgres } from './lib/postgres.js';

const shutdownTimeoutMs = 5_000;

const start = async () => {
  await checkPostgres();
  await connectMongo();

  const app = createApp();
  const server = app.listen(environment.port, environment.host, () => {
    console.log(`TedixHunt API listening on ${environment.host}:${environment.port}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Shutting down TedixHunt API.`);

    const timeout = setTimeout(() => {
      console.error('Timed out while shutting down TedixHunt API.');
      process.exit(1);
    }, shutdownTimeoutMs);

    server.close(async () => {
      try {
        await Promise.all([disconnectPostgres(), disconnectMongo()]);
        clearTimeout(timeout);
        process.exit(0);
      } catch {
        console.error('Failed to close database connections.');
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch(() => {
  console.error('Failed to start API. Check database connectivity and environment configuration.');
  process.exit(1);
});
