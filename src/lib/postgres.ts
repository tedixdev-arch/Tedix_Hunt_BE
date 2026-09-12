import { Pool } from 'pg';
import { readDatabaseConfig } from '../config/database.js';

let pool: Pool | undefined;

export const getPostgresPool = (): Pool => {
  if (!pool) {
    pool = new Pool(readDatabaseConfig());
    // Idle connections can fail outside a request. Never log connection credentials.
    pool.on('error', () => console.error('An idle PostgreSQL connection failed.'));
  }
  return pool;
};

export const checkPostgres = async (): Promise<void> => {
  await getPostgresPool().query('SELECT 1');
};

export const disconnectPostgres = async (): Promise<void> => {
  const current = pool;
  pool = undefined;
  await current?.end();
};
