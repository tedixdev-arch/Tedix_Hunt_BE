import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import { baselineMigration } from './migrations/001_baseline.js';
import { userRolesMigration } from './migrations/002_user_roles.js';
import type { Migration } from './migrations/index.js';

const migrations = [baselineMigration, userRolesMigration];
const trackedMigration: Migration = {
  id: '003_test_tracking',
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
      `INSERT INTO users (id, email, role, name) VALUES
       ('00000000-0000-0000-0000-000000000001', 'participant@example.com', 'participant', 'Participant'),
       ('00000000-0000-0000-0000-000000000002', 'creator@example.com', 'creator', 'Creator')`,
    );
  });

  afterAll(async () => {
    client?.release();
    await pool.end();
  });

  it('creates migration history and applies the non-destructive baseline', async () => {
    await expect(runMigrations(client, migrations)).resolves.toEqual([
      '001_baseline',
      '002_user_roles',
    ]);

    const history = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id',
    );
    expect(history.rows).toEqual([{ id: '001_baseline' }, { id: '002_user_roles' }]);
    const users = await client.query<{ id: string; email: string; role: string }>(
      `SELECT u.id, u.email, ur.role FROM users u JOIN user_roles ur ON ur.user_id = u.id
       ORDER BY u.email`,
    );
    expect(users.rows).toEqual([
      {
        id: '00000000-0000-0000-0000-000000000002',
        email: 'creator@example.com',
        role: 'creator',
      },
      {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'participant@example.com',
        role: 'participant',
      },
    ]);

    await expect(
      client.query(
        `INSERT INTO user_roles (user_id, role)
         VALUES ('00000000-0000-0000-0000-000000000001', 'participant')`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      client.query(
        `INSERT INTO user_roles (user_id, role)
         VALUES ('00000000-0000-0000-0000-000000000099', 'participant')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });

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
      id: '003_test_tracking',
      async up() {
        executions += 1;
      },
    };
    const testMigrations = [...migrations, countingMigration];

    await expect(runMigrations(client, testMigrations)).resolves.toEqual(['003_test_tracking']);
    await expect(runMigrations(client, testMigrations)).resolves.toEqual([]);
    expect(executions).toBe(1);
  });

  it('enforces organization membership uniqueness, foreign keys, and cascades', async () => {
    const organizationId = '00000000-0000-0000-0000-000000000010';
    const ownerId = '00000000-0000-0000-0000-000000000002';
    const memberId = '00000000-0000-0000-0000-000000000001';
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO organizations (id, name, owner_id) VALUES ($1, $2, $3)',
      [organizationId, 'Integrity test', ownerId],
    );
    await client.query(
      'INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)',
      [organizationId, memberId],
    );

    await client.query('SAVEPOINT duplicate_membership');
    await expect(
      client.query(
        'INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)',
        [organizationId, memberId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await client.query('ROLLBACK TO SAVEPOINT duplicate_membership');

    await client.query('DELETE FROM users WHERE id = $1', [memberId]);
    const afterUserDelete = await client.query(
      'SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [organizationId, memberId],
    );
    expect(afterUserDelete.rowCount).toBe(0);

    await client.query(
      'INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)',
      [organizationId, ownerId],
    );
    await client.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
    const afterOrganizationDelete = await client.query(
      'SELECT 1 FROM organization_members WHERE organization_id = $1',
      [organizationId],
    );
    expect(afterOrganizationDelete.rowCount).toBe(0);
    await client.query('COMMIT');
  });

  it('does not record a failed migration', async () => {
    const failingMigration: Migration = {
      id: '004_test_failure',
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
