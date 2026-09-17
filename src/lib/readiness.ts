import { Client } from 'pg';
import { environment } from '../config/environment.js';

// A diagnostic connection must never run the startup schema creation code.
export const checkDatabaseReadiness = async (): Promise<void> => {
  if (!environment.databaseUrl) throw new Error('Database is not configured');

  const client = new Client({
    connectionString: environment.databaseUrl,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
    statement_timeout: 2_000,
    application_name: 'tedixhunt-readiness',
    options: '-c default_transaction_read_only=on',
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end();
  }
};
