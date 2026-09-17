import 'dotenv/config';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { readEnvironment } from '../config/environment.js';
import { discoverMigrations, type Migration } from './migrations/index.js';

const MIGRATION_LOCK_ID = 1_907_202_014;

const validateMigrations = (migrations: readonly Migration[]): Migration[] => {
  const ordered = [...migrations].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();

  for (const migration of ordered) {
    if (!/^\d{3}_[a-z0-9_]+$/.test(migration.id)) {
      throw new Error(`Invalid migration id: ${migration.id}`);
    }
    if (ids.has(migration.id)) {
      throw new Error(`Duplicate migration id: ${migration.id}`);
    }
    ids.add(migration.id);
  }

  return ordered;
};

export const runMigrations = async (
  client: PoolClient,
  migrations: readonly Migration[],
): Promise<string[]> => {
  const ordered = validateMigrations(migrations);
  const appliedNow: string[] = [];

  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const result = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
    const applied = new Set(result.rows.map(({ id }) => id));

    for (const migration of ordered) {
      if (applied.has(migration.id)) continue;

      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
        appliedNow.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
  }

  return appliedNow;
};

export const migrate = async (): Promise<void> => {
  const databaseUrl = readEnvironment().databaseUrl;
  if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations.');

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    try {
      const directory = fileURLToPath(new URL('./migrations', import.meta.url));
      const applied = await runMigrations(client, await discoverMigrations(directory));
      console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'No migrations to apply.');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((error: unknown) => {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  });
}
