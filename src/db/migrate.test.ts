import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import { baselineMigration } from './migrations/001_baseline.js';
import { userRolesMigration } from './migrations/002_user_roles.js';
import { coreHuntRecordsMigration } from './migrations/003_core_hunt_records.js';
import { huntGeneralSetupMigration } from './migrations/004_hunt_general_setup.js';
import { huntTemplateSelectionMigration } from './migrations/005_hunt_template_selection.js';
import { huntPilotOptionsMigration } from './migrations/006_hunt_pilot_options.js';
import type { Migration } from './migrations/index.js';

const migrations = [
  baselineMigration, userRolesMigration, coreHuntRecordsMigration,
  huntGeneralSetupMigration, huntTemplateSelectionMigration, huntPilotOptionsMigration,
];
const trackedMigration: Migration = {
  id: '006_test_tracking',
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
    const schemaPath = fileURLToPath(new URL('./pre_migration_baseline.sql', import.meta.url));
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
    await expect(runMigrations(client, migrations.slice(0, 3))).resolves.toEqual([
      '001_baseline',
      '002_user_roles',
      '003_core_hunt_records',
    ]);
    await client.query(
      `INSERT INTO organizations (id, name, owner_id)
       VALUES ('00000000-0000-0000-0000-000000000090', 'Existing organization',
               '00000000-0000-0000-0000-000000000002')`,
    );
    await client.query(
      `INSERT INTO hunts (id, organization_id, created_by_user_id, name, status)
       VALUES ('00000000-0000-0000-0000-000000000091',
               '00000000-0000-0000-0000-000000000090',
               '00000000-0000-0000-0000-000000000002', 'Existing Hunt', 'draft')`,
    );
    await expect(runMigrations(client, migrations)).resolves.toEqual([
      '004_hunt_general_setup', '005_hunt_template_selection', '006_hunt_pilot_options',
    ]);

    const existing = await client.query(
      `SELECT country, region, city, start_date, start_time, timezone,
              duration_minutes, capacity, contact_name, template_key, template_version,
              template_snapshot, hunt_format, team_size, access_mode, difficulty, checkpoint_order
       FROM hunts WHERE id = '00000000-0000-0000-0000-000000000091'`,
    );
    expect(existing.rows).toEqual([{
      country: null, region: null, city: null, start_date: null, start_time: null,
      timezone: null, duration_minutes: null, capacity: null, contact_name: null,
      template_key: null, template_version: null, template_snapshot: null,
      hunt_format: null, team_size: null, access_mode: null, difficulty: null,
      checkpoint_order: null,
    }]);

    const history = await client.query<{ id: string }>(
      'SELECT id FROM schema_migrations ORDER BY id',
    );
    expect(history.rows).toEqual([
      { id: '001_baseline' },
      { id: '002_user_roles' },
      { id: '003_core_hunt_records' },
      { id: '004_hunt_general_setup' },
      { id: '005_hunt_template_selection' },
      { id: '006_hunt_pilot_options' },
    ]);
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

    for (const table of [
      'users',
      'organizations',
      'organization_members',
      'refresh_tokens',
      'hunts',
      'hunt_participants',
      'teams',
      'team_members',
      'hunt_roles',
    ]) {
      const result = await client.query<{ exists: string | null }>('SELECT to_regclass($1) AS exists', [
        `public.${table}`,
      ]);
      expect(result.rows[0]?.exists).toBe(table);
    }
  });

  it('is idempotent and does not execute an already-applied migration again', async () => {
    let executions = 0;
    const countingMigration: Migration = {
      id: '006_test_tracking',
      async up() {
        executions += 1;
      },
    };
    const testMigrations = [...migrations, countingMigration];

    await expect(runMigrations(client, testMigrations)).resolves.toEqual(['006_test_tracking']);
    await expect(runMigrations(client, testMigrations)).resolves.toEqual([]);
    expect(executions).toBe(1);
  });

  it('enforces Hunt records, same-Hunt team membership, roles, and cascades', async () => {
    const creatorId = '10000000-0000-0000-0000-000000000001';
    const participantId = '10000000-0000-0000-0000-000000000002';
    const organizationA = '20000000-0000-0000-0000-000000000001';
    const organizationB = '20000000-0000-0000-0000-000000000002';
    const huntA = '30000000-0000-0000-0000-000000000001';
    const huntB = '30000000-0000-0000-0000-000000000002';
    const enrollmentA = '40000000-0000-0000-0000-000000000001';
    const enrollmentB = '40000000-0000-0000-0000-000000000002';
    const teamA1 = '50000000-0000-0000-0000-000000000001';
    const teamA2 = '50000000-0000-0000-0000-000000000002';
    const teamB = '50000000-0000-0000-0000-000000000003';
    let savepoint = 0;
    const expectConstraint = async (sql: string, values: unknown[], code: string) => {
      const name = `expected_constraint_${savepoint++}`;
      await client.query(`SAVEPOINT ${name}`);
      await expect(client.query(sql, values)).rejects.toMatchObject({ code });
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    };

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, role) VALUES
       ($1, 'hunt-creator@example.com', 'creator'),
       ($2, 'hunt-participant@example.com', 'participant')`,
      [creatorId, participantId],
    );
    await client.query(
      `INSERT INTO organizations (id, name, owner_id) VALUES
       ($1, 'Organization A', $3), ($2, 'Organization B', $3)`,
      [organizationA, organizationB, creatorId],
    );

    for (const status of ['draft', 'published', 'active', 'paused', 'cancelled', 'finished']) {
      const { rowCount } = await client.query(
        `INSERT INTO hunts (organization_id, created_by_user_id, name, status)
         VALUES ($1, $2, $3, $4)`,
        [organizationA, creatorId, `Status ${status}`, status],
      );
      expect(rowCount).toBe(1);
    }
    await expectConstraint(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status)
       VALUES ($1, $2, 'Invalid status', 'scheduled')`,
      [organizationA, creatorId],
      '23514',
    );
    await expectConstraint(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status)
       VALUES ('99999999-0000-0000-0000-000000000001', $1, 'Invalid org', 'draft')`,
      [creatorId],
      '23503',
    );
    await client.query(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status, country, region, city,
                          start_date, start_time, timezone, duration_minutes, capacity, contact_name)
       VALUES ($1, $2, 'General Setup', 'draft', 'Romania', 'Cluj', 'Cluj Napoca',
               '2026-09-12', '10:00:00', 'Europe/Bucharest', 90, 24, 'Ana Pop')`,
      [organizationA, creatorId],
    );
    for (const [column, value] of [['duration_minutes', 0], ['duration_minutes', -1], ['capacity', 0], ['capacity', -1]]) {
      await expectConstraint(
        `INSERT INTO hunts (organization_id, created_by_user_id, name, status, ${column})
         VALUES ($1, $2, 'Invalid General Setup', 'draft', $3)`,
        [organizationA, creatorId, value],
        '23514',
      );
    }
    await expectConstraint(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status, template_version)
       VALUES ($1, $2, 'Invalid template version', 'draft', 0)`,
      [organizationA, creatorId],
      '23514',
    );
    await client.query(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status, hunt_format,
                          team_size, access_mode, difficulty, checkpoint_order)
       VALUES ($1, $2, 'Pilot options', 'draft', 'team', 4, 'invitation_only', 'easy', 'recommended')`,
      [organizationA, creatorId],
    );
    for (const [column, value] of [
      ['hunt_format', 'single'], ['team_size', 3], ['team_size', 5], ['access_mode', 'open'],
      ['difficulty', 'medium'], ['difficulty', 'advanced'], ['checkpoint_order', 'short'],
    ]) {
      await expectConstraint(
        `INSERT INTO hunts (organization_id, created_by_user_id, name, status, ${column})
         VALUES ($1, $2, 'Unsupported pilot option', 'draft', $3)`,
        [organizationA, creatorId, value],
        '23514',
      );
    }
    await expectConstraint(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status)
       VALUES ($1, '99999999-0000-0000-0000-000000000002', 'Invalid user', 'draft')`,
      [organizationA],
      '23503',
    );

    await client.query(
      `INSERT INTO hunts (id, organization_id, created_by_user_id, name, status) VALUES
       ($1, $3, $5, 'Hunt A', 'draft'), ($2, $4, $5, 'Hunt B', 'published')`,
      [huntA, huntB, organizationA, organizationB, creatorId],
    );
    await client.query(
      `INSERT INTO hunt_participants (id, hunt_id, user_id) VALUES
       ($1, $3, $5), ($2, $4, $5)`,
      [enrollmentA, enrollmentB, huntA, huntB, participantId],
    );
    await expectConstraint(
      'INSERT INTO hunt_participants (hunt_id, user_id) VALUES ($1, $2)',
      [huntA, participantId],
      '23505',
    );

    await client.query(
      `INSERT INTO teams (id, hunt_id, name) VALUES
       ($1, $4, 'Explorers'), ($2, $4, 'Pathfinders'), ($3, $5, 'Explorers')`,
      [teamA1, teamA2, teamB, huntA, huntB],
    );
    await expectConstraint(
      'INSERT INTO teams (hunt_id, name) VALUES ($1, $2)',
      [huntA, 'Explorers'],
      '23505',
    );

    await client.query(
      `INSERT INTO team_members (hunt_id, team_id, hunt_participant_id)
       VALUES ($1, $2, $3)`,
      [huntA, teamA1, enrollmentA],
    );
    await expectConstraint(
      'INSERT INTO team_members (hunt_id, team_id, hunt_participant_id) VALUES ($1, $2, $3)',
      [huntA, teamA1, enrollmentA],
      '23505',
    );
    await expectConstraint(
      'INSERT INTO team_members (hunt_id, team_id, hunt_participant_id) VALUES ($1, $2, $3)',
      [huntA, teamA2, enrollmentA],
      '23505',
    );
    await expectConstraint(
      'INSERT INTO team_members (hunt_id, team_id, hunt_participant_id) VALUES ($1, $2, $3)',
      [huntB, teamB, enrollmentA],
      '23503',
    );

    await client.query(
      `INSERT INTO hunt_roles (hunt_id, user_id, role) VALUES
       ($1, $3, 'organizer'), ($1, $4, 'supervisor'), ($2, $3, 'organizer')`,
      [huntA, huntB, creatorId, participantId],
    );
    await expectConstraint(
      `INSERT INTO hunt_roles (hunt_id, user_id, role) VALUES ($1, $2, 'organizer')`,
      [huntA, creatorId],
      '23505',
    );
    await expectConstraint(
      `INSERT INTO hunt_roles (hunt_id, user_id, role) VALUES ($1, $2, 'captain')`,
      [huntA, creatorId],
      '23514',
    );
    expect(
      (await client.query(`SELECT 1 FROM user_roles WHERE role = 'supervisor'`)).rowCount,
    ).toBe(0);

    await client.query('DELETE FROM teams WHERE id = $1', [teamA1]);
    expect(
      (await client.query('SELECT 1 FROM team_members WHERE team_id = $1', [teamA1])).rowCount,
    ).toBe(0);
    await client.query(
      `INSERT INTO team_members (hunt_id, team_id, hunt_participant_id)
       VALUES ($1, $2, $3)`,
      [huntB, teamB, enrollmentB],
    );
    await client.query('DELETE FROM hunts WHERE id = $1', [huntB]);
    for (const [table, clause] of [
      ['hunt_participants', 'hunt_id'],
      ['teams', 'hunt_id'],
      ['team_members', 'hunt_id'],
      ['hunt_roles', 'hunt_id'],
    ]) {
      expect((await client.query(`SELECT 1 FROM ${table} WHERE ${clause} = $1`, [huntB])).rowCount)
        .toBe(0);
    }
    await client.query('ROLLBACK');
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
      id: '006_test_failure',
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
