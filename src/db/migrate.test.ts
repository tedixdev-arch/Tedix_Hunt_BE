import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import { baselineMigration } from './migrations/001_baseline.js';
import type { Migration } from './migrations/index.js';

const migrations = [baselineMigration];
const trackedMigration: Migration = {
  id: '002_test_tracking',
  async up() {},
};

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('PostgreSQL migrations', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
    await client.query(await readFile(schemaPath, 'utf8'));
    await client.query(
      `INSERT INTO users (email, role, name) VALUES ('existing@example.com', 'user', 'Existing User')`,
    );
  });

  afterAll(async () => {
    client?.release();
    await pool.end();
  });

  it('creates migration history and applies the non-destructive baseline', async () => {
    await expect(runMigrations(client, migrations)).resolves.toEqual(['001_baseline']);

    const history = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id',
    );
    expect(history.rows).toEqual([{ id: '001_baseline' }]);
    const user = await client.query<{ name: string }>(
      `SELECT name FROM users WHERE email = 'existing@example.com'`,
    );
    expect(user.rows).toEqual([{ name: 'Existing User' }]);

    for (const table of ['users', 'organizations', 'organization_members', 'refresh_tokens']) {
      const result = await client.query<{ exists: string | null }>('SELECT to_regclass($1) AS exists', [
        `public.${table}`,
      ]);
      expect(result.rows[0]?.exists).toBe(table);
    }
  });

  it('is idempotent and does not execute an already-applied migration again', async () => {
    let executions = 0;
    const countingMigration: Migration = {
      id: '002_test_tracking',
      async up() {
        executions += 1;
      },
    };
    const testMigrations = [...migrations, countingMigration];

    await expect(runMigrations(client, testMigrations)).resolves.toEqual(['002_test_tracking']);
    await expect(runMigrations(client, testMigrations)).resolves.toEqual([]);
    expect(executions).toBe(1);
  });

  it('does not record a failed migration', async () => {
    const failingMigration: Migration = {
      id: '003_test_failure',
      async up(db) {
        await db.query('CREATE TABLE rolled_back_test (id INTEGER)');
        throw new Error('expected migration failure');
      },
    };

    await expect(
      runMigrations(client, [...migrations, trackedMigration, failingMigration]),
    ).rejects.toThrow(
      'expected migration failure',
    );
    const history = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [
      failingMigration.id,
    ]);
    expect(history.rowCount).toBe(0);
    const table = await client.query<{ exists: string | null }>(
      `SELECT to_regclass('public.rolled_back_test') AS exists`,
    );
    expect(table.rows[0]?.exists).toBeNull();
  });

  it('fails when applied migration history is missing from the repository', async () => {
    await client.query(`INSERT INTO schema_migrations (id) VALUES ('999_removed_migration')`);

    await expect(runMigrations(client, [...migrations, trackedMigration])).rejects.toThrow(
      'Database contains applied migration(s) missing from the repository: 999_removed_migration',
    );
  });
});
