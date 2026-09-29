import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { runMigrations } from './migrate.js';
import { baselineMigration } from './migrations/001_baseline.js';
import { userRolesMigration } from './migrations/002_user_roles.js';
import { coreHuntRecordsMigration } from './migrations/003_core_hunt_records.js';
import { huntGeneralSetupMigration } from './migrations/004_hunt_general_setup.js';
import { huntTemplateSelectionMigration } from './migrations/005_hunt_template_selection.js';
import { huntPilotOptionsMigration } from './migrations/006_hunt_pilot_options.js';
import { huntAccessCodeMigration } from './migrations/007_hunt_access_code.js';
import { huntRewardsMigration } from './migrations/008_hunt_rewards.js';
import { organizerApplicationsMigration } from './migrations/009_organizer_applications.js';
import { organizerApprovalMigration } from './migrations/010_organizer_approval.js';
import { professionalActivationTokensMigration } from './migrations/011_professional_activation_tokens.js';
import { professionalActivationPurposesMigration } from './migrations/012_professional_activation_purposes.js';
import { userAccountStatusMigration } from './migrations/013_user_account_status.js';
import { retiredAccountStatusMigration } from './migrations/014_retired_account_status.js';
import { creatorApplicationsMigration } from './migrations/015_creator_applications.js';
import { huntTemplateVersionsMigration } from './migrations/016_hunt_template_versions.js';
import { signalClujNapocaV1Migration } from './migrations/017_signal_cluj_napoca_v1.js';
import { templateSubmissionMigration } from './migrations/018_template_submission.js';
import { signalClujNapocaV1 } from '../domain/templates/signalClujNapocaV1.js';
import type { Migration } from './migrations/index.js';

const migrations = [
  baselineMigration, userRolesMigration, coreHuntRecordsMigration,
  huntGeneralSetupMigration, huntTemplateSelectionMigration, huntPilotOptionsMigration,
  huntAccessCodeMigration, huntRewardsMigration, organizerApplicationsMigration,
  organizerApprovalMigration, professionalActivationTokensMigration,
  professionalActivationPurposesMigration,
  userAccountStatusMigration,
  retiredAccountStatusMigration,
  creatorApplicationsMigration,
  huntTemplateVersionsMigration,
  signalClujNapocaV1Migration,
  templateSubmissionMigration,
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
  let closeApplicationPool: (() => Promise<void>) | undefined;

  const application = async () => {
    // The application pool normally reads DATABASE_URL. Point it at the isolated integration
    // database before importing the app so HTTP requests exercise real repositories and SQL.
    process.env.DATABASE_URL = databaseUrl;
    const { environment } = await import('../config/environment.js');
    environment.databaseUrl = databaseUrl;
    const [{ createApp }, { signJwt }, postgres] = await Promise.all([
      import('../app.js'), import('../lib/jwt.js'), import('../lib/postgres.js'),
    ]);
    closeApplicationPool = async () => postgres.pool.end();
    return { app: createApp(), signJwt };
  };

  const insertAdmin = async (email: string) => {
    const passwordHash = await bcrypt.hash('AdminPass1!', 10);
    const result = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, name, is_guest)
       VALUES ($1, $2, 'participant', 'Integration Admin', FALSE) RETURNING id`,
      [email, passwordHash],
    );
    await client.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')", [result.rows[0].id]);
    return result.rows[0].id;
  };

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
    await closeApplicationPool?.();
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
    await expect(runMigrations(client, migrations.slice(0, 11))).resolves.toEqual([
      '004_hunt_general_setup', '005_hunt_template_selection', '006_hunt_pilot_options',
      '007_hunt_access_code', '008_hunt_rewards', '009_organizer_applications',
      '010_organizer_approval', '011_professional_activation_tokens',
    ]);
    await client.query(
      `INSERT INTO professional_activation_tokens
         (user_id, token_hash, purpose, expires_at, created_by)
       VALUES ('00000000-0000-0000-0000-000000000001', 'pre-012-admin',
               'admin_activation', now() + interval '1 day',
               '00000000-0000-0000-0000-000000000002')`,
    );
    await expect(runMigrations(client, migrations)).resolves.toEqual([
      '012_professional_activation_purposes',
      '013_user_account_status',
      '014_retired_account_status',
      '015_creator_applications',
      '016_hunt_template_versions',
      '017_signal_cluj_napoca_v1',
      '018_template_submission',
    ]);
    try {
      await expect(client.query(
        `SELECT purpose FROM professional_activation_tokens
         WHERE token_hash = 'pre-012-admin'`,
      )).resolves.toMatchObject({ rows: [{ purpose: 'admin_activation' }] });
    } finally {
      // This suite shares its migrated schema across tests. Remove this preservation fixture
      // entirely so its created_by foreign key and token row cannot leak into later assertions.
      await client.query(
        `DELETE FROM professional_activation_tokens WHERE token_hash = 'pre-012-admin'`,
      );
    }

    const existing = await client.query(
      `SELECT country, region, city, start_date, start_time, timezone,
              duration_minutes, capacity, contact_name, template_key, template_version,
              template_snapshot, hunt_format, team_size, access_mode, difficulty, checkpoint_order,
              access_code
       FROM hunts WHERE id = '00000000-0000-0000-0000-000000000091'`,
    );
    expect(existing.rows).toEqual([{
      country: null, region: null, city: null, start_date: null, start_time: null,
      timezone: null, duration_minutes: null, capacity: null, contact_name: null,
      template_key: null, template_version: null, template_snapshot: null,
      hunt_format: null, team_size: null, access_mode: null, difficulty: null,
      checkpoint_order: null, access_code: null,
    }]);

    await client.query(
      `UPDATE hunts SET access_code = '7KPM4XQ2'
       WHERE id = '00000000-0000-0000-0000-000000000091'`,
    );
    await expect(client.query(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status, access_code)
       VALUES ('00000000-0000-0000-0000-000000000090',
               '00000000-0000-0000-0000-000000000002', 'Duplicate code', 'published', '7KPM4XQ2')`,
    )).rejects.toMatchObject({ code: '23505' });
    await expect(client.query(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status, access_code)
       VALUES ('00000000-0000-0000-0000-000000000090',
               '00000000-0000-0000-0000-000000000002', 'Invalid code', 'published', 'SIGNAL26')`,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status, access_code)
       VALUES ('00000000-0000-0000-0000-000000000090',
               '00000000-0000-0000-0000-000000000002', 'Valid code', 'published', 'M8R2HD7W')`,
    )).resolves.toMatchObject({ rowCount: 1 });

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
      { id: '007_hunt_access_code' },
      { id: '008_hunt_rewards' },
      { id: '009_organizer_applications' },
      { id: '010_organizer_approval' },
      { id: '011_professional_activation_tokens' },
      { id: '012_professional_activation_purposes' },
      { id: '013_user_account_status' },
      { id: '014_retired_account_status' },
      { id: '015_creator_applications' },
      { id: '016_hunt_template_versions' },
      { id: '017_signal_cluj_napoca_v1' },
      { id: '018_template_submission' },
    ]);
    const users = await client.query<{ id: string; email: string; role: string; account_status: string }>(
      `SELECT u.id, u.email, ur.role, u.account_status FROM users u JOIN user_roles ur ON ur.user_id = u.id
       ORDER BY u.email`,
    );
    expect(users.rows).toEqual([
      {
        id: '00000000-0000-0000-0000-000000000002',
        email: 'creator@example.com',
        role: 'creator',
        account_status: 'active',
      },
      {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'participant@example.com',
        role: 'participant',
        account_status: 'active',
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
      'hunt_leaderboard_rewards',
      'hunt_special_awards',
      'organizer_applications',
      'professional_activation_tokens',
      'creator_applications',
      'hunt_templates',
      'hunt_template_versions',
    ]) {
      const result = await client.query<{ exists: string | null }>('SELECT to_regclass($1) AS exists', [
        `public.${table}`,
      ]);
      expect(result.rows[0]?.exists).toBe(table);
    }
  });

  it('round-trips the immutable platform Signal v1 payload through PostgreSQL JSONB', async () => {
    const result = await client.query<{
      key: string;
      template_origin: string;
      template_created_by_user_id: string | null;
      status: string;
      version: number;
      version_origin: string;
      version_created_by_user_id: string | null;
      content: typeof signalClujNapocaV1;
    }>(
      `SELECT t.key, t.origin AS template_origin,
              t.created_by_user_id AS template_created_by_user_id, t.status,
              v.version, v.origin AS version_origin,
              v.created_by_user_id AS version_created_by_user_id, v.content
       FROM hunt_templates t
       JOIN hunt_template_versions v ON v.template_id = t.id
       WHERE t.key = $1`,
      [signalClujNapocaV1.key],
    );

    expect(result.rows).toHaveLength(1);
    const persisted = result.rows[0];
    expect(persisted).toMatchObject({
      key: 'signal-cluj-napoca', template_origin: 'platform',
      template_created_by_user_id: null, status: 'approved', version: 1,
      version_origin: 'platform', version_created_by_user_id: null,
    });
    // PostgreSQL JSONB may reorder object keys, so semantic deep equality rather than raw
    // JSON.stringify hashing is the correct round-trip invariant.
    expect(persisted.content).toEqual(signalClujNapocaV1);
    expect(persisted.content.checkpoints).toHaveLength(7);
    expect(persisted.content.checkpoints.map(({ checkpoint }) => checkpoint))
      .toEqual([1, 2, 3, 4, 5, 6, 7]);

    const stoneGate = persisted.content.checkpoints[1];
    expect(stoneGate).toMatchObject({
      mistakeSegments: signalClujNapocaV1.checkpoints[1].mistakeSegments,
      mistakeExplanations: signalClujNapocaV1.checkpoints[1].mistakeExplanations,
      correctedExpression: '6x = 42, then x = 7',
    });
    expect(persisted.content.checkpoints[2]).toMatchObject({
      teamRule: 'A = 1, B = 2 ... Z = 26',
    });
    expect(persisted.content.scoring).toEqual(signalClujNapocaV1.scoring);
  });

  it('reads only approved Templates and their latest versions for the catalog', async () => {
    await application();
    const { HuntTemplates } = await import('../models/HuntTemplate.js');
    const approved = await HuntTemplates.create({
      key: 'catalog-approved-fixture', origin: 'platform', status: 'approved',
    });
    await HuntTemplates.createVersion1({
      templateId: approved.id, origin: 'platform',
      content: { displayName: 'Old persisted name', theme: 'Old persisted theme' },
    });
    await HuntTemplates.createVersion({
      templateId: approved.id, version: 3, origin: 'platform',
      content: { displayName: 'Latest persisted name', theme: 'Latest persisted theme' },
    });
    const draft = await HuntTemplates.create({
      key: 'catalog-draft-fixture', origin: 'platform', status: 'draft',
    });
    await HuntTemplates.createVersion1({
      templateId: draft.id, origin: 'platform',
      content: { displayName: 'Hidden draft', theme: 'Hidden' },
    });

    const catalog = await HuntTemplates.listApprovedWithLatestVersion();
    expect(catalog.map(({ key }) => key)).toEqual([...catalog.map(({ key }) => key)].sort());
    expect(catalog).toContainEqual({
      key: 'signal-cluj-napoca', version: 1, content: signalClujNapocaV1,
    });
    expect(catalog).toContainEqual({
      key: approved.key, version: 3,
      content: { displayName: 'Latest persisted name', theme: 'Latest persisted theme' },
    });
    expect(catalog.some(({ key }) => key === draft.key)).toBe(false);
    await expect(HuntTemplates.findApprovedByKeyWithLatestVersion(approved.key)).resolves
      .toMatchObject({ key: approved.key, version: 3 });
    await expect(HuntTemplates.findApprovedByKeyWithLatestVersion(draft.key)).resolves.toBeNull();

    // A missing approved row must stay missing rather than being masked by the legacy descriptor.
    await client.query(
      "UPDATE hunt_templates SET status = 'submitted', submitted_version = 1 WHERE key = $1",
      [signalClujNapocaV1.key],
    );
    await expect(HuntTemplates.findApprovedByKeyWithLatestVersion(signalClujNapocaV1.key))
      .resolves.toBeNull();
    await client.query("UPDATE hunt_templates SET status = 'approved' WHERE key = $1", [signalClujNapocaV1.key]);
  });

  it('snapshots the approved latest persisted Template version into each Hunt', async () => {
    const { app, signJwt } = await application();
    const userId = '00000000-0000-0000-0000-000000000002';
    const organizationId = '00000000-0000-0000-0000-000000000090';
    const existingHuntId = '00000000-0000-0000-0000-000000000091';
    const auth = `Bearer ${signJwt({ sub: userId, type: 'access' })}`;
    await client.query(
      `INSERT INTO hunt_roles (hunt_id, user_id, role) VALUES ($1, $2, 'organizer')
       ON CONFLICT DO NOTHING`,
      [existingHuntId, userId],
    );

    try {
      const selectedV1 = await request(app).patch(`/api/hunts/${existingHuntId}`)
        .set('Authorization', auth).send({ templateKey: signalClujNapocaV1.key })
        .expect(200);
      expect(selectedV1.body).toMatchObject({
        templateKey: signalClujNapocaV1.key, templateVersion: 1,
        templateSnapshot: signalClujNapocaV1,
      });
      expect(selectedV1.body.templateSnapshot).toEqual(signalClujNapocaV1);

      const template = await client.query<{ id: string }>(
        'SELECT id FROM hunt_templates WHERE key = $1', [signalClujNapocaV1.key],
      );
      const version2Content = { ...signalClujNapocaV1, version: 2, displayName: 'Signal v2 fixture' };
      await client.query(
        `INSERT INTO hunt_template_versions (template_id, version, content, origin)
         VALUES ($1, 2, $2, 'platform')`,
        [template.rows[0].id, version2Content],
      );

      const created = await request(app).post('/api/hunts').set('Authorization', auth)
        .send({ organizationId, name: 'Latest Template Hunt' }).expect(201);
      const selectedV2 = await request(app).patch(`/api/hunts/${created.body.id}`)
        .set('Authorization', auth).send({ templateKey: signalClujNapocaV1.key })
        .expect(200);
      expect(selectedV2.body).toMatchObject({
        templateKey: signalClujNapocaV1.key, templateVersion: 2,
        templateSnapshot: version2Content,
      });

      const unchanged = await client.query(
        'SELECT template_version, template_snapshot FROM hunts WHERE id = $1', [existingHuntId],
      );
      expect(unchanged.rows[0]).toEqual({
        template_version: 1, template_snapshot: signalClujNapocaV1,
      });
    } finally {
      await client.query(
        `DELETE FROM hunt_template_versions WHERE template_id =
         (SELECT id FROM hunt_templates WHERE key = $1) AND version = 2`,
        [signalClujNapocaV1.key],
      );
      await client.query("DELETE FROM hunts WHERE name = 'Latest Template Hunt'");
    }
  });

  it('owner-scopes Creator reads and returns each latest version across lifecycle states', async () => {
    const { app, signJwt } = await application();
    const creatorA = '00000000-0000-0000-0000-000000000002';
    const creatorB = '00000000-0000-0000-0000-000000000003';
    const auth = `Bearer ${signJwt({ sub: creatorA, type: 'access' })}`;
    await client.query(
      `INSERT INTO users (id, email, role, name)
       VALUES ($1, 'creator-b@example.com', 'creator', 'Creator B') ON CONFLICT DO NOTHING`,
      [creatorB],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, 'creator') ON CONFLICT DO NOTHING`,
      [creatorB],
    );

    const keys = ['read-approved', 'read-changes', 'read-draft', 'read-submitted'];
    try {
      for (const [index, status] of ['approved', 'changes_requested', 'draft', 'submitted'].entries()) {
        const template = await client.query<{ id: string }>(
          `INSERT INTO hunt_templates (key, origin, created_by_user_id, status)
           VALUES ($1, 'creator', $2, $3) RETURNING id`,
          [keys[index], creatorA, status === 'submitted' ? 'draft' : status],
        );
        await client.query(
          `INSERT INTO hunt_template_versions
             (template_id, version, content, origin, created_by_user_id)
           VALUES ($1, 1, $2, 'creator', $3), ($1, 2, $4, 'creator', $3)`,
          [template.rows[0].id, { complete: 'old' }, creatorA, { complete: 'latest', status }],
        );
        if (status === 'submitted') {
          await client.query(
            `UPDATE hunt_templates SET status = 'submitted', submitted_version = 2 WHERE id = $1`,
            [template.rows[0].id],
          );
        }
      }
      const other = await client.query<{ id: string }>(
        `INSERT INTO hunt_templates (key, origin, created_by_user_id, status)
         VALUES ('read-private-b', 'creator', $1, 'draft') RETURNING id`,
        [creatorB],
      );
      await client.query(
        `INSERT INTO hunt_template_versions
           (template_id, version, content, origin, created_by_user_id)
         VALUES ($1, 1, '{"private":true}', 'creator', $2)`,
        [other.rows[0].id, creatorB],
      );

      const list = await request(app).get('/api/creator/templates')
        .set('Authorization', auth).expect(200);
      const fixtures = list.body.filter(({ key }: { key: string }) => key.startsWith('read-'));
      expect(fixtures.map(({ key }: { key: string }) => key)).toEqual(keys);
      expect(fixtures.every(({ version }: { version: number }) => version === 2)).toBe(true);
      expect(fixtures.map(({ status }: { status: string }) => status)).toEqual([
        'approved', 'changes_requested', 'draft', 'submitted',
      ]);
      expect(fixtures.map(({ submittedVersion }: { submittedVersion: number | null }) => submittedVersion))
        .toEqual([null, null, null, 2]);
      expect(fixtures[0].content).toEqual({ complete: 'latest', status: 'approved' });
      expect(list.body.some(({ key }: { key: string }) => key === signalClujNapocaV1.key)).toBe(false);
      expect(list.body.some(({ key }: { key: string }) => key === 'read-private-b')).toBe(false);

      const detail = await request(app).get('/api/creator/templates/read-draft')
        .set('Authorization', auth).expect(200);
      expect(detail.body).toEqual(expect.objectContaining({ key: 'read-draft', version: 2 }));
      const privateResponse = await request(app).get('/api/creator/templates/read-private-b')
        .set('Authorization', auth).expect(404);
      const unknownResponse = await request(app).get('/api/creator/templates/read-unknown')
        .set('Authorization', auth).expect(404);
      expect(privateResponse.body).toEqual(unknownResponse.body);
    } finally {
      await client.query("DELETE FROM hunt_templates WHERE key LIKE 'read-%'");
      await client.query('DELETE FROM users WHERE id = $1', [creatorB]);
    }
  });

  it('creates sequential immutable Creator versions without changing an existing Hunt snapshot', async () => {
    const { app, signJwt } = await application();
    const creatorId = '00000000-0000-0000-0000-000000000002';
    const key = 'versioned-creator-draft';
    const auth = `Bearer ${signJwt({ sub: creatorId, type: 'access' })}`;
    const base = {
      key, version: 1, displayName: 'Version one', theme: 'Integration',
      mission: { title: 'Mission', complete: true },
      configuration: { duration: 30, nested: { retained: true } },
      scoring: { start: 100 }, checkpoints: [{ id: 'first', order: 1 }],
    };
    const huntId = '00000000-0000-0000-0000-000000000092';

    try {
      await request(app).post('/api/creator/templates').set('Authorization', auth)
        .send({ key, content: base }).expect(201);
      await client.query(
        `INSERT INTO hunts
           (id, organization_id, created_by_user_id, name, status,
            template_key, template_version, template_snapshot)
         VALUES ($1, '00000000-0000-0000-0000-000000000090', $2,
                 'Immutable snapshot fixture', 'draft', $3, 1, $4)`,
        [huntId, creatorId, key, base],
      );

      const v2 = {
        ...base, version: 2, displayName: 'Version two',
        checkpoints: [...base.checkpoints, { id: 'second', order: 2, payload: ['round-trip'] }],
      };
      await request(app).post(`/api/creator/templates/${key}/versions`)
        .set('Authorization', auth).send({ content: v2 }).expect(201, {
          key, version: 2, status: 'draft', origin: 'creator', content: v2,
        });
      const v3 = { ...v2, version: 3, displayName: 'Version three' };
      await request(app).post(`/api/creator/templates/${key}/versions`)
        .set('Authorization', auth).send({ content: v3 }).expect(201);

      const template = await client.query<{ id: string }>(
        'SELECT id FROM hunt_templates WHERE key = $1', [key],
      );
      const versions = await client.query(
        `SELECT version, content, origin, created_by_user_id
         FROM hunt_template_versions WHERE template_id = $1 ORDER BY version`,
        [template.rows[0].id],
      );
      expect(versions.rows).toEqual([
        { version: 1, content: base, origin: 'creator', created_by_user_id: creatorId },
        { version: 2, content: v2, origin: 'creator', created_by_user_id: creatorId },
        { version: 3, content: v3, origin: 'creator', created_by_user_id: creatorId },
      ]);
      await request(app).get(`/api/creator/templates/${key}`).set('Authorization', auth)
        .expect(200, {
          key, version: 3, status: 'draft', origin: 'creator', submittedVersion: null, content: v3,
        });
      await expect(client.query(
        'SELECT template_version, template_snapshot FROM hunts WHERE id = $1', [huntId],
      )).resolves.toMatchObject({ rows: [{ template_version: 1, template_snapshot: base }] });

      const invalidV5 = { ...v3, version: 5 };
      await request(app).post(`/api/creator/templates/${key}/versions`)
        .set('Authorization', auth).send({ content: invalidV5 })
        .expect(400, { error: 'invalid_input' });
      await expect(client.query(
        'SELECT count(*)::integer AS count FROM hunt_template_versions WHERE template_id = $1',
        [template.rows[0].id],
      )).resolves.toMatchObject({ rows: [{ count: 3 }] });

      // Both requests calculate under the same identity row lock; at most the correct v4 succeeds.
      const v4 = { ...v3, version: 4, displayName: 'Concurrent version four' };
      const concurrent = await Promise.all([
        request(app).post(`/api/creator/templates/${key}/versions`)
          .set('Authorization', auth).send({ content: v4 }),
        request(app).post(`/api/creator/templates/${key}/versions`)
          .set('Authorization', auth).send({ content: v4 }),
      ]);
      expect(concurrent.map(({ status }) => status).sort()).toEqual([201, 400]);
      await expect(client.query(
        `SELECT version FROM hunt_template_versions WHERE template_id = $1 ORDER BY version`,
        [template.rows[0].id],
      )).resolves.toMatchObject({ rows: [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }] });

      const submitted = await request(app).post(`/api/creator/templates/${key}/submit`)
        .set('Authorization', auth).send({ version: 4 }).expect(200);
      expect(submitted.body).toEqual({
        key, version: 4, status: 'submitted', origin: 'creator', content: v4,
      });
      await expect(client.query(
        'SELECT status, submitted_version FROM hunt_templates WHERE id = $1',
        [template.rows[0].id],
      )).resolves.toMatchObject({ rows: [{ status: 'submitted', submitted_version: 4 }] });
      await request(app).get(`/api/creator/templates/${key}`).set('Authorization', auth)
        .expect(200, {
          key, version: 4, status: 'submitted', origin: 'creator', submittedVersion: 4, content: v4,
        });
      await request(app).post(`/api/creator/templates/${key}/versions`)
        .set('Authorization', auth).send({ content: { ...v4, version: 5 } })
        .expect(409, { error: 'template_not_editable' });
      const catalog = await request(app).get('/api/hunt-templates')
        .set('Authorization', auth).expect(200);
      expect(catalog.body.some((entry: { key: string }) => entry.key === key)).toBe(false);
      await expect(client.query(
        'SELECT template_version, template_snapshot FROM hunts WHERE id = $1', [huntId],
      )).resolves.toMatchObject({ rows: [{ template_version: 1, template_snapshot: base }] });
    } finally {
      await client.query('DELETE FROM hunts WHERE id = $1', [huntId]);
      await client.query('DELETE FROM hunt_templates WHERE key = $1', [key]);
    }
  });

  it('persists Template identities and immutable version content with provenance', async () => {
    await application();
    const { HuntTemplates } = await import('../models/HuntTemplate.js');
    const creatorId = '00000000-0000-0000-0000-000000000002';

    await expect(client.query(
      `INSERT INTO hunt_templates (key, origin, status)
       VALUES ('invalid-creator-template', 'creator', 'draft')`,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `INSERT INTO hunt_templates (key, origin, created_by_user_id, status)
       VALUES ('invalid-creator-fk', 'creator', gen_random_uuid(), 'draft')`,
    )).rejects.toMatchObject({ code: '23503' });

    const platform = await HuntTemplates.create({
      key: 'integration-platform-template', origin: 'platform', status: 'approved',
    });
    expect(platform.createdByUserId).toBeNull();
    await expect(HuntTemplates.create({
      key: platform.key, origin: 'platform', status: 'draft',
    })).rejects.toMatchObject({ code: '23505' });

    const creator = await HuntTemplates.create({
      key: 'integration-creator-template', origin: 'creator',
      createdByUserId: creatorId, status: 'draft',
    });
    expect(creator.createdByUserId).toBe(creatorId);
    await expect(client.query(
      `INSERT INTO hunt_template_versions (template_id, version, content, origin)
       VALUES ($1, 0, '{}', 'platform')`, [platform.id],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `INSERT INTO hunt_template_versions (template_id, version, content, origin)
       VALUES ($1, 1, '{}', 'creator')`, [creator.id],
    )).rejects.toMatchObject({ code: '23514' });

    const version1Content = { setup: { title: 'Concrete platform Template' } };
    const version1 = await HuntTemplates.createVersion1({
      templateId: platform.id, content: version1Content, origin: 'platform',
    });
    expect(version1).toMatchObject({ version: 1, content: version1Content, createdByUserId: null });
    await expect(HuntTemplates.createVersion1({
      templateId: platform.id, content: {}, origin: 'platform',
    })).rejects.toMatchObject({ code: '23505' });

    await HuntTemplates.createVersion1({
      templateId: creator.id, content: { setup: 'creator' }, origin: 'creator',
      createdByUserId: creatorId,
    });
    const version2 = await HuntTemplates.createVersion({
      templateId: platform.id, version: 2, content: { setup: { title: 'Version two' } },
      origin: 'platform',
    });

    await expect(HuntTemplates.findByKey(platform.key)).resolves.toMatchObject({ id: platform.id });
    await expect(HuntTemplates.getVersion(platform.id, 1)).resolves.toMatchObject({
      id: version1.id, content: version1Content,
    });
    await expect(HuntTemplates.getLatestVersion(platform.id)).resolves.toMatchObject({
      id: version2.id, version: 2,
    });
    await expect(HuntTemplates.getVersion(platform.id, 1)).resolves.toMatchObject({
      id: version1.id, content: version1Content,
    });
    await expect(HuntTemplates.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: platform.id, latestVersion: 2 }),
      expect.objectContaining({ id: creator.id, latestVersion: 1 }),
    ]));
  });

  it('runs self-registration through approval and normal Creator login with the original password', async () => {
    const email = 'creator-self-registration@example.com';
    const password = 'OriginalPass1!';
    const adminEmail = 'creator-review-admin@example.com';
    const { app, signJwt } = await application();
    const adminId = await insertAdmin(adminEmail);
    let userId: string | undefined;
    try {
      const submitted = await request(app).post('/api/creator-applications').send({
        name: 'Self Registered Creator', email, password, confirmPassword: password,
      }).expect(201);
      expect(submitted.body.status).toBe('pending');

      const identity = await client.query<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM users WHERE email = $1', [email],
      );
      userId = identity.rows[0].id;
      expect(identity.rows[0].password_hash).not.toBe(password);
      await expect(bcrypt.compare(password, identity.rows[0].password_hash)).resolves.toBe(true);
      await expect(client.query(
        "SELECT role FROM user_roles WHERE user_id = $1 AND role = 'creator'", [userId],
      )).resolves.toMatchObject({ rows: [] });
      await expect(client.query(
        'SELECT status FROM creator_applications WHERE id = $1', [submitted.body.id],
      )).resolves.toMatchObject({ rows: [{ status: 'pending' }] });
      await expect(client.query(
        'SELECT id FROM professional_activation_tokens WHERE user_id = $1', [userId],
      )).resolves.toMatchObject({ rows: [] });

      // Possessing valid identity credentials is not Creator authorization while pending.
      await request(app).post('/api/auth/creator/login').send({ email, password })
        .expect(401, { error: 'invalid_credentials' });

      const passwordHashBeforeApproval = identity.rows[0].password_hash;
      const bearer = `Bearer ${signJwt({ sub: adminId, type: 'access' })}`;
      await request(app).post(`/api/creator-applications/${submitted.body.id}/approve`)
        .set('Authorization', bearer).expect(200);

      const approved = await client.query<{ password_hash: string; status: string }>(
        `SELECT users.password_hash, creator_applications.status
         FROM users JOIN creator_applications ON creator_applications.user_id = users.id
         WHERE creator_applications.id = $1`, [submitted.body.id],
      );
      expect(approved.rows[0]).toEqual({ password_hash: passwordHashBeforeApproval, status: 'approved' });
      await expect(client.query(
        "SELECT role FROM user_roles WHERE user_id = $1 AND role = 'creator'", [userId],
      )).resolves.toMatchObject({ rows: [{ role: 'creator' }] });
      await expect(client.query(
        'SELECT id FROM professional_activation_tokens WHERE user_id = $1', [userId],
      )).resolves.toMatchObject({ rows: [] });

      const login = await request(app).post('/api/auth/creator/login').send({ email, password }).expect(200);
      expect(login.body.user).toMatchObject({ id: userId, roles: ['creator'] });
      expect(login.body.tokens).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String) });
    } finally {
      if (userId) await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM creator_applications WHERE email = $1', [email]);
      await client.query('DELETE FROM users WHERE email IN ($1, $2)', [email, adminEmail]);
    }
  });

  it('preserves an established identity password through application and approval', async () => {
    const email = 'existing-password-creator@example.com';
    const existingPassword = 'ExistingPass1!';
    const submittedPassword = 'SubmittedPass2!';
    const adminEmail = 'existing-password-review-admin@example.com';
    const existingHash = await bcrypt.hash(existingPassword, 10);
    const { app, signJwt } = await application();
    const adminId = await insertAdmin(adminEmail);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, name, is_guest)
       VALUES ($1, $2, 'participant', 'Existing Identity', FALSE) RETURNING id`, [email, existingHash],
    );
    const userId = inserted.rows[0].id;
    try {
      const submitted = await request(app).post('/api/creator-applications').send({
        name: 'Existing Identity', email, password: submittedPassword, confirmPassword: submittedPassword,
      }).expect(201);
      await expect(client.query('SELECT password_hash FROM users WHERE id = $1', [userId]))
        .resolves.toMatchObject({ rows: [{ password_hash: existingHash }] });

      const bearer = `Bearer ${signJwt({ sub: adminId, type: 'access' })}`;
      await request(app).post(`/api/creator-applications/${submitted.body.id}/approve`)
        .set('Authorization', bearer).expect(200);
      await expect(client.query('SELECT password_hash FROM users WHERE id = $1', [userId]))
        .resolves.toMatchObject({ rows: [{ password_hash: existingHash }] });
      await request(app).post('/api/auth/creator/login')
        .send({ email, password: submittedPassword }).expect(401);
      await request(app).post('/api/auth/creator/login')
        .send({ email, password: existingPassword }).expect(200);
    } finally {
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM creator_applications WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM users WHERE email IN ($1, $2)', [email, adminEmail]);
    }
  });

  it('establishes a password once for an active passwordless identity and does not replace it on approval', async () => {
    const email = 'passwordless-creator-applicant@example.com';
    const password = 'EstablishedPass1!';
    const adminEmail = 'passwordless-review-admin@example.com';
    const { app, signJwt } = await application();
    const adminId = await insertAdmin(adminEmail);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role, name, is_guest)
       VALUES ($1, NULL, 'participant', 'Passwordless Identity', FALSE) RETURNING id`, [email],
    );
    const userId = inserted.rows[0].id;
    try {
      const submitted = await request(app).post('/api/creator-applications').send({
        name: 'Passwordless Identity', email, password, confirmPassword: password,
      }).expect(201);
      const established = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1', [userId],
      );
      await expect(bcrypt.compare(password, established.rows[0].password_hash)).resolves.toBe(true);

      const bearer = `Bearer ${signJwt({ sub: adminId, type: 'access' })}`;
      await request(app).post(`/api/creator-applications/${submitted.body.id}/approve`)
        .set('Authorization', bearer).expect(200);
      await expect(client.query('SELECT password_hash FROM users WHERE id = $1', [userId]))
        .resolves.toMatchObject({ rows: [{ password_hash: established.rows[0].password_hash }] });
      await request(app).post('/api/auth/creator/login').send({ email, password }).expect(200);
    } finally {
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM creator_applications WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM users WHERE email IN ($1, $2)', [email, adminEmail]);
    }
  });

  it('keeps the real Admin-provisioned Creator activation token flow one-time', async () => {
    const email = 'admin-provisioned-creator@example.com';
    const password = 'ActivatedPass1!';
    const adminEmail = 'provisioning-admin@example.com';
    const { app, signJwt } = await application();
    const adminId = await insertAdmin(adminEmail);
    let userId: string | undefined;
    try {
      const bearer = `Bearer ${signJwt({ sub: adminId, type: 'access' })}`;
      const provisioned = await request(app).post('/api/admin/users/professional')
        .set('Authorization', bearer).send({ email, name: 'Provisioned Creator', role: 'creator' })
        .expect(201);
      userId = provisioned.body.user.id;
      expect(provisioned.body).toMatchObject({
        role: 'creator', activationRequired: true, activationToken: expect.any(String),
      });
      await expect(client.query(
        `SELECT purpose, consumed_at FROM professional_activation_tokens
         WHERE user_id = $1`, [userId],
      )).resolves.toMatchObject({ rows: [{ purpose: 'creator_activation', consumed_at: null }] });

      await request(app).post('/api/auth/creator/activate')
        .send({ token: provisioned.body.activationToken, password }).expect(200);
      await request(app).post('/api/auth/creator/login').send({ email, password }).expect(200);
      await request(app).post('/api/auth/creator/activate')
        .send({ token: provisioned.body.activationToken, password: 'AnotherPass2!' })
        .expect(401, { error: 'invalid_or_expired_activation' });
      await expect(client.query(
        `SELECT consumed_at IS NOT NULL AS consumed FROM professional_activation_tokens
         WHERE user_id = $1`, [userId],
      )).resolves.toMatchObject({ rows: [{ consumed: true }] });
    } finally {
      if (userId) {
        await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM professional_activation_tokens WHERE user_id = $1', [userId]);
      }
      await client.query('DELETE FROM users WHERE email IN ($1, $2)', [email, adminEmail]);
    }
  });

  it('allows a retired email to be cleared and immediately reused despite a claimed fake address', async () => {
    const retiredId = '00000000-0000-0000-0000-000000000081';
    const claimantId = '00000000-0000-0000-0000-000000000082';
    const replacementId = '00000000-0000-0000-0000-000000000083';
    const originalEmail = 'retirement-original@example.com';
    const predictableEmail = `retired+${retiredId}@internal.invalid`;
    try {
      await client.query(
        `INSERT INTO users (id, email, role) VALUES
           ($1, $2, 'creator'), ($3, $4, 'participant')`,
        [retiredId, originalEmail, claimantId, predictableEmail],
      );
      await client.query(
        `UPDATE users SET email = NULL, account_status = 'retired' WHERE id = $1`,
        [retiredId],
      );
      await expect(client.query(
        `INSERT INTO users (id, email, role) VALUES ($1, $2, 'participant')`,
        [replacementId, originalEmail],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(client.query('SELECT email FROM users WHERE id = $1', [retiredId]))
        .resolves.toMatchObject({ rows: [{ email: null }] });
    } finally {
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        [retiredId, claimantId, replacementId],
      ]);
    }
  });

  it('enforces professional activation token purpose and active-token uniqueness', async () => {
    const participantId = '00000000-0000-0000-0000-000000000001';
    const creatorId = '00000000-0000-0000-0000-000000000002';
    const insert = `INSERT INTO professional_activation_tokens
      (user_id, token_hash, purpose, expires_at, created_by)
      VALUES ($1, $2, $3, now() + interval '1 day', $4)`;

    try {
      await expect(client.query(insert, [participantId, 'hash-one', 'unsupported', creatorId]))
        .rejects.toMatchObject({ code: '23514' });

      await expect(client.query(insert, [participantId, 'hash-one', 'admin_activation', creatorId]))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(client.query(insert, [creatorId, 'hash-organizer', 'organizer_activation', participantId]))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(client.query(insert, [participantId, 'hash-creator', 'creator_activation', creatorId]))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(client.query(insert, [creatorId, 'hash-one', 'admin_activation', participantId]))
        .rejects.toMatchObject({ code: '23505' });
      await expect(client.query(insert, [participantId, 'hash-two', 'admin_activation', creatorId]))
        .rejects.toMatchObject({ code: '23505' });

      await client.query(
        `UPDATE professional_activation_tokens SET consumed_at = now()
         WHERE user_id = $1 AND purpose = 'admin_activation'`, [participantId],
      );
      await expect(client.query(insert, [participantId, 'hash-two', 'admin_activation', creatorId]))
        .resolves.toMatchObject({ rowCount: 1 });

      const tokens = await client.query(
        `SELECT token_hash, consumed_at IS NULL AS active
         FROM professional_activation_tokens
         WHERE user_id = $1 AND purpose = 'admin_activation' ORDER BY created_at`, [participantId],
      );
      expect(tokens.rows).toEqual([
        { token_hash: 'hash-one', active: false },
        { token_hash: 'hash-two', active: true },
      ]);
    } finally {
      await client.query(
        `DELETE FROM professional_activation_tokens
         WHERE token_hash IN ('hash-one', 'hash-two', 'hash-organizer', 'hash-creator')`,
      );
    }
  });

  it('defaults Organizer applications to pending and enforces its enum constraints', async () => {
    const inserted = await client.query<{ status: string }>(
      `INSERT INTO organizer_applications
         (name, email, organization_name, organization_type, reason)
       VALUES ('Applicant', 'applicant@example.com', 'School', 'school', 'Host Hunts')
       RETURNING status`,
    );
    expect(inserted.rows[0]?.status).toBe('pending');

    await expect(client.query(
      `INSERT INTO organizer_applications
         (name, email, organization_name, organization_type, reason)
       VALUES ('Applicant', 'applicant@example.com', 'School', 'company', 'Host Hunts')`,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `UPDATE organizer_applications SET status = 'reviewing'
       WHERE email = 'applicant@example.com'`,
    )).rejects.toMatchObject({ code: '23514' });
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

  it('enforces reward constraints, uniqueness, and Hunt cascade deletion', async () => {
    const huntId = '00000000-0000-0000-0000-000000000091';
    const validDetails = [huntId, 'organizer', 'physical', null, 'Book voucher', null, 1];
    await client.query(
      `INSERT INTO hunt_leaderboard_rewards
         (hunt_id, place, provider, kind, category, name, description, quantity)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`, validDetails,
    );
    await expect(client.query(
      `INSERT INTO hunt_leaderboard_rewards
         (hunt_id, place, provider, kind, category, name, description, quantity)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`, validDetails,
    )).rejects.toMatchObject({ code: '23505' });

    for (const [column, value] of [
      ['place', 0], ['place', 51], ['quantity', 0], ['provider', 'sponsor'],
      ['kind', 'cash'], ['category', 'unknown'],
    ]) {
      await expect(client.query(
        `INSERT INTO hunt_leaderboard_rewards
           (hunt_id, place, provider, kind, category, name, quantity)
         VALUES ($1, 2, 'organizer', 'physical', NULL, 'Prize', 1) RETURNING id`, [huntId],
      ).then(async ({ rows }) => {
        await client.query(`UPDATE hunt_leaderboard_rewards SET ${column} = $2 WHERE id = $1`, [rows[0].id, value]);
      })).rejects.toMatchObject({ code: '23514' });
      await client.query('DELETE FROM hunt_leaderboard_rewards WHERE hunt_id = $1 AND place = 2', [huntId]);
    }

    await client.query(
      `INSERT INTO hunt_special_awards
         (hunt_id, definition_key, provider, kind, category, name, quantity)
       VALUES ($1, 'team-precision', 'tedix_inventory', 'virtual', 'profile_badge', NULL, 1)`, [huntId],
    );
    await expect(client.query(
      `INSERT INTO hunt_special_awards
         (hunt_id, definition_key, provider, kind, category, name, quantity)
       VALUES ($1, 'team-precision', 'tedix_inventory', 'virtual', 'achievement', NULL, 1)`, [huntId],
    )).rejects.toMatchObject({ code: '23505' });

    await client.query(
      `INSERT INTO hunts (id, organization_id, created_by_user_id, name, status)
       VALUES ('00000000-0000-0000-0000-000000000099',
               '00000000-0000-0000-0000-000000000090',
               '00000000-0000-0000-0000-000000000002', 'Cascade rewards', 'draft')`,
    );
    await client.query(
      `INSERT INTO hunt_leaderboard_rewards
         (hunt_id, place, provider, kind, name, quantity)
       VALUES ('00000000-0000-0000-0000-000000000099', 1, 'organizer', 'physical', 'Prize', 1)`,
    );
    await client.query(
      `INSERT INTO hunt_special_awards
         (hunt_id, definition_key, provider, kind, name, quantity)
       VALUES ('00000000-0000-0000-0000-000000000099', 'team-precision', 'organizer', 'physical', 'Prize', 1)`,
    );
    await client.query("DELETE FROM hunts WHERE id = '00000000-0000-0000-0000-000000000099'");
    const cascade = await client.query(
      `SELECT (SELECT count(*) FROM hunt_leaderboard_rewards WHERE hunt_id = '00000000-0000-0000-0000-000000000099') AS leaderboard,
              (SELECT count(*) FROM hunt_special_awards WHERE hunt_id = '00000000-0000-0000-0000-000000000099') AS special`,
    );
    expect(cascade.rows[0]).toEqual({ leaderboard: '0', special: '0' });
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
