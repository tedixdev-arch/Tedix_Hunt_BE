import type { PoolConfig } from 'pg';

export const readDatabaseConfig = (env: NodeJS.ProcessEnv = process.env): PoolConfig => {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new Error();
    }
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL with a host and database name.');
  }
  const max = Number(env.PGPOOL_MAX ?? '10');
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error('PGPOOL_MAX must be an integer from 1 to 100.');
  }
  return {
    connectionString,
    max,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
    application_name: 'tedixhunt-api',
  };
};
