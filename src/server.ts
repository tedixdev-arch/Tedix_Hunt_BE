import 'dotenv/config';
import { createApp } from './app.js';
import { environment } from './config/environment.js';
import { connectPostgres, disconnectPostgres } from './lib/postgres.js';
import { createGracefulShutdown } from './lib/shutdown.js';
import { PlatformSettings } from './models/PlatformSettings.js';

const start = async () => {
  await connectPostgres();
  // Platform Settings are read from memory; keep every instance within 30 s of an Admin change.
  // A failed read (e.g. migration 041 not yet applied) keeps documented defaults instead of stopping the API.
  const refreshSettings = () => PlatformSettings.refresh()
    .catch(error => console.error('Platform settings refresh failed; using defaults', error instanceof Error ? error.message : error));
  await refreshSettings();
  const settingsRefresh = setInterval(() => void refreshSettings(), 30_000);
  settingsRefresh.unref();

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
