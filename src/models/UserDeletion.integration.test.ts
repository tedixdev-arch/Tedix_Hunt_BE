import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

// Only use the supplied URL to create/drop a unique disposable database.
const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `user_deletion_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;

suite('account deletion against real PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let pool: Pool | undefined;
  let created = false;
  let model: typeof import('./User.js');
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(testUrl!);
    url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const filename of (await readdir(directory)).filter((name) => /^\d{3}_.*\.ts$/.test(name)).sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js');
    environment.databaseUrl = url.toString();
    pool = (await import('../lib/postgres.js')).pool;
    model = await import('./User.js');
    app = (await import('../app.js')).createApp();
    signJwt = (await import('../lib/jwt.js')).signJwt;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  const fixture = async (role = 'creator', status = 'active') => {
    const refreshToken = randomUUID();
    const activationToken = randomUUID();
    const user = (await db.query(
      `INSERT INTO users (email, name, password_hash, role, tedix_user_id, account_status)
       VALUES ($1, 'Disposable D03', 'disposable-hash', $2, $3, $4) RETURNING *`,
      [`d03-${randomUUID()}@example.invalid`, role, randomUUID(), status],
    )).rows[0];
    await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [user.id, role]);
    await db.query("INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [user.id, refreshToken]);
    await db.query(
      `INSERT INTO professional_activation_tokens (user_id, token_hash, purpose, expires_at, created_by)
       VALUES ($1, $2, 'creator_activation', now() + interval '1 hour', $1)`,
      [user.id, createHash('sha256').update(activationToken).digest('hex')],
    );
    return { ...user, refreshToken, activationToken };
  };
  const application = async (applicant: string, reviewer: string | null = null, status = 'pending') =>
    (await db.query(
      `INSERT INTO creator_applications (user_id, name, email, status, reviewed_by, reviewed_at)
       VALUES ($1, 'D03 applicant', $2, $3, $4, CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END) RETURNING *`,
      [applicant, `${randomUUID()}@example.invalid`, status, reviewer],
    )).rows[0];
  const template = async (owner: string, versionAuthor: string) => {
    const row = (await db.query(
      `INSERT INTO hunt_templates (key, origin, created_by_user_id, status)
       VALUES ($1, 'platform', $2, 'draft') RETURNING *`, [`d03-${randomUUID()}`, owner],
    )).rows[0];
    await db.query(
      `INSERT INTO hunt_template_versions (template_id, version, content, origin, created_by_user_id)
       VALUES ($1, 1, '{"historical":"immutable"}', 'platform', $2)`, [row.id, versionAuthor],
    );
    await db.query("UPDATE hunt_templates SET status = 'submitted', submitted_version = 1 WHERE id = $1", [row.id]);
    return row;
  };
  const history = async () => Promise.all(
    ['creator_applications', 'hunt_templates', 'hunt_template_versions', 'organizations', 'hunts', 'organizer_applications']
      .map(async (table) => (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows),
  );
  const credentials = async (id: string) => Promise.all(
    ['users', 'user_roles', 'refresh_tokens', 'professional_activation_tokens'].map(async (table) =>
      (await db.query(`SELECT * FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} = $1 ORDER BY 1`, [id])).rows),
  );
  const retired = async (user: { id: string; role: string }) => {
    const [users, roles, sessions, activations] = await credentials(user.id);
    expect(users).toEqual([expect.objectContaining({
      id: user.id, role: user.role, email: null, name: 'Deleted user', password_hash: null,
      tedix_user_id: null, is_guest: false, account_status: 'retired',
    })]);
    expect([roles, sessions, activations]).toEqual([[], [], []]);
  };

  it.each(['pending', 'approved', 'rejected'])('retires an applicant with only a %s Creator application', async (status) => {
    const user = await fixture();
    await application(user.id, null, status);
    const before = await history();
    expect(await model.User.deleteControlled(user.id)).toBe('retired');
    await retired(user);
    expect(await history()).toEqual(before);
  });

  it('retires a reviewer with only review attribution', async () => {
    const reviewer = await fixture();
    await application((await fixture()).id, reviewer.id, 'approved');
    const before = await history();
    expect(await model.User.deleteControlled(reviewer.id)).toBe('retired');
    await retired(reviewer);
    expect(await history()).toEqual(before);
  });

  it.each(['template', 'version'])('retires isolated %s provenance, including platform content', async (kind) => {
    const target = await fixture();
    const other = await fixture();
    await template(kind === 'template' ? target.id : other.id, kind === 'version' ? target.id : other.id);
    const before = await history();
    expect(await model.User.deleteControlled(target.id)).toBe('retired');
    await retired(target);
    expect(await history()).toEqual(before);
  });

  it.each(['active', 'blocked'])('retires multiple Creator dependencies for an %s account and tolerates repeated removal', async (status) => {
    const user = await fixture('creator', status);
    await application(user.id, user.id, 'approved');
    const row = await template(user.id, user.id);
    await db.query("UPDATE hunt_templates SET origin = 'creator', status = 'approved' WHERE id = $1", [row.id]);
    await db.query("UPDATE hunt_template_versions SET origin = 'creator' WHERE template_id = $1", [row.id]);
    const before = await history();
    expect(await model.User.deleteControlled(user.id)).toBe('retired');
    expect(await model.User.deleteControlled(user.id)).toBe('retired');
    await retired(user);
    expect(await history()).toEqual(before);
  });

  it.each([false, true])('preserves Organizer/Hunt history with Creator dependencies=%s', async (creator) => {
    const user = await fixture('organizer');
    const org = (await db.query("INSERT INTO organizations (name, owner_id) VALUES ('D03 org', $1) RETURNING id", [user.id])).rows[0];
    await db.query("INSERT INTO hunts (organization_id, created_by_user_id, name, status) VALUES ($1, $2, 'D03 hunt', 'finished')", [org.id, user.id]);
    if (creator) await application(user.id);
    const before = await history();
    expect(await model.User.deleteControlled(user.id)).toBe('retired');
    await retired(user);
    expect(await history()).toEqual(before);
  });

  it.each(['active', 'blocked'])('hard-deletes a dependency-free %s account and onboarding artifacts', async (status) => {
    const user = await fixture('creator', status);
    await db.query(
      `INSERT INTO organizer_applications (user_id, name, email, organization_name, organization_type, reason)
       VALUES ($1, 'D03', $2, 'D03 org', 'school', 'Disposable verification')`, [user.id, user.email],
    );
    expect(await model.User.deleteControlled(user.id)).toBe('deleted');
    expect(await credentials(user.id)).toEqual([[], [], [], []]);
    expect((await db.query('SELECT id FROM organizer_applications WHERE user_id = $1', [user.id])).rows).toEqual([]);
    expect(await model.User.deleteControlled(user.id)).toBeNull();
  });

  it('protects the last active Admin before considering Creator dependencies', async () => {
    const user = await fixture('admin');
    await application(user.id);
    const before = await credentials(user.id);
    await expect(model.User.deleteControlled(user.id)).rejects.toBeInstanceOf(model.LastActiveAdminError);
    expect(await credentials(user.id)).toEqual(before);
    const second = await fixture('admin');
    expect(await model.User.deleteControlled(user.id)).toBe('retired');
    await retired(user);
    await db.query("UPDATE users SET account_status = 'blocked' WHERE id = $1", [second.id]);
    expect(await model.User.deleteControlled(second.id)).toBe('deleted');
  });

  it.each(['retired', 'deleted'])('rolls back every credential change on failed %s commit', async (outcome) => {
    const user = await fixture();
    if (outcome === 'retired') await application(user.id);
    // Test-only deferred trigger forces a genuine COMMIT failure after all mutations.
    await db.query(`CREATE FUNCTION fail_d03() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'D03 forced failure'; END $$;
      CREATE CONSTRAINT TRIGGER fail_d03 AFTER UPDATE OR DELETE ON users
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_d03()`);
    const before = await credentials(user.id);
    const beforeHistory = await history();
    try {
      await expect(model.User.deleteControlled(user.id)).rejects.toThrow('D03 forced failure');
      expect(await credentials(user.id)).toEqual(before);
      expect(await history()).toEqual(beforeHistory);
    } finally {
      await db.query('DROP TRIGGER fail_d03 ON users; DROP FUNCTION fail_d03()');
    }
    expect(await model.User.deleteControlled(user.id)).toBe(outcome);
  });

  it('returns HTTP success for retirement/deletion and preserves authorization and retired-state restrictions', async () => {
    const actor = await fixture('admin');
    const target = await fixture();
    await application(target.id);
    const before = await history();
    const bearer = (id: string) => `Bearer ${signJwt({ sub: id, type: 'access' })}`;
    await request(app).delete(`/api/admin/users/${target.id}`).expect(401);
    await request(app).delete(`/api/admin/users/${actor.id}`).set('Authorization', bearer(target.id)).expect(403);
    await request(app).delete(`/api/admin/users/${actor.id}`).set('Authorization', bearer(actor.id))
      .expect(409, { error: 'self_delete_not_allowed' });
    await request(app).delete(`/api/admin/users/${target.id}`).set('Authorization', bearer(actor.id))
      .expect(200, { status: 'retired' });
    await retired(target);
    expect(await history()).toEqual(before);
    await request(app).get('/api/auth/me').set('Authorization', bearer(target.id)).expect(401);
    await request(app).post('/api/auth/creator/login')
      .send({ email: target.email, password: 'Disposable123!' }).expect(401);
    await request(app).post('/api/auth/refresh').send({ refreshToken: target.refreshToken }).expect(401);
    await request(app).post('/api/auth/creator/activate')
      .send({ token: target.activationToken, password: 'Disposable123!' }).expect(401);
    await request(app).post(`/api/admin/users/${target.id}/unblock`).set('Authorization', bearer(actor.id))
      .expect(409, { error: 'account_retired' });
    const disposable = await fixture();
    await request(app).delete(`/api/admin/users/${disposable.id}`).set('Authorization', bearer(actor.id))
      .expect(200, { status: 'deleted' });
    expect(await credentials(disposable.id)).toEqual([[], [], [], []]);
  });
});
