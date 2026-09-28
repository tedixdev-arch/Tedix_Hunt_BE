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
    ]) {
      const result = await client.query<{ exists: string | null }>('SELECT to_regclass($1) AS exists', [
        `public.${table}`,
      ]);
      expect(result.rows[0]?.exists).toBe(table);
    }
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
