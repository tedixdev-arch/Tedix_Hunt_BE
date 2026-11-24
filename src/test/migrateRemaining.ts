import { readdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

/**
 * Slice suites first prove their own migration against an older schema. The application they then
 * exercise reads the current schema, so bring the database up to date after those slice assertions.
 */
export async function applyRemainingMigrations(client: PoolClient, migrations: Migration[]) {
  const directory = new URL('../db/migrations/', import.meta.url);
  const known = new Set(migrations.map(migration => migration.id));
  for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name)).sort()) {
    if (!known.has(filename.replace(/\.ts$/, ''))) migrations.push((await import(new URL(filename, directory).href)).default);
  }
  return runMigrations(client, migrations);
}
