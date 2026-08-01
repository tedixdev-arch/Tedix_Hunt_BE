import { createApp } from './app.js';
import { environment } from './config/environment.js';

const shutdownTimeoutMs = 5_000;

const app = createApp();
const server = app.listen(environment.port, environment.host, () => {
  console.log(
    `TedixHunt API listening on ${environment.host}:${environment.port}`,
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`${signal} received. Shutting down TedixHunt API.`);

  const timeout = setTimeout(() => {
    console.error('Timed out while shutting down TedixHunt API.');
    process.exit(1);
  }, shutdownTimeoutMs);

  server.close(() => {
    clearTimeout(timeout);
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
