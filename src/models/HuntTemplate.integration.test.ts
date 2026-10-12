import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

// TEST_DATABASE_URL is only used to CREATE a fresh database. Never reset its schema.
// The supplied role needs CREATEDB; DATABASE_URL is deliberately ignored.
const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `creator_delete_test_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;

suite('Creator deletion against real PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let model: typeof import('./HuntTemplate.js');
  let applicationPool: Pool | undefined;
  let created = false;
  let creatorId: string;
  let organizationId: string;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const isolatedUrl = new URL(testUrl!);
    isolatedUrl.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: isolatedUrl.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const filename of (await readdir(directory)).filter((name) => /^\d{3}_.*\.ts$/.test(name)).sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
    } finally {
      client.release();
    }
    // Configure before loading the production repository; no mocked SQL or pool.
    const { environment } = await import('../config/environment.js');
    environment.databaseUrl = isolatedUrl.toString();
    applicationPool = (await import('../lib/postgres.js')).pool;
    model = await import('./HuntTemplate.js');
    creatorId = (await db.query(
      "INSERT INTO users (email, role) VALUES ('delete-test@example.com', 'creator') RETURNING id",
    )).rows[0].id;
    organizationId = (await db.query(
      "INSERT INTO organizations (name, owner_id) VALUES ('Deletion test', $1) RETURNING id", [creatorId],
    )).rows[0].id;
  }, 30_000);

  afterAll(async () => {
    await applicationPool?.end();
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  const fixture = async (status = 'draft') => {
    const key = `delete-${randomUUID()}`;
    const template = await model.HuntTemplates.create({ key, origin: 'creator', createdByUserId: creatorId, status: 'draft' });
    for (const version of [1, 2]) {
      await model.HuntTemplates.createVersion({ templateId: template.id, version, content: { key, version }, origin: 'creator', createdByUserId: creatorId });
    }
    if (status !== 'draft') {
      await db.query('UPDATE hunt_templates SET status = $2, submitted_version = 1 WHERE id = $1', [template.id, status]);
    }
    return template;
  };

  const snapshot = async (id: string) => ({
    templates: (await db.query('SELECT * FROM hunt_templates WHERE id = $1', [id])).rows,
    versions: (await db.query('SELECT * FROM hunt_template_versions WHERE template_id = $1 ORDER BY version', [id])).rows,
  });

  it.each(['draft', 'changes_requested'])('commits deletion of unused %s and every version', async (status) => {
    const template = await fixture(status);
    const before = await snapshot(template.id);
    expect(before.versions).toHaveLength(2);
    if (status === 'changes_requested') {
      expect(before.templates[0].submitted_version).toBe(1);
      const constraint = await db.query(
        "SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'hunt_templates_submitted_version_fkey'",
      );
      expect(constraint.rows).toEqual([{ condeferrable: true, condeferred: true }]);
    }
    await model.HuntTemplates.deleteCreatorDraft(template.key, creatorId);
    // A separate connection observes the committed cascade and deferred FK success.
    expect(await snapshot(template.id)).toEqual({ templates: [], versions: [] });
    await expect(model.HuntTemplates.deleteCreatorDraft(template.key, creatorId))
      .rejects.toBeInstanceOf(model.HuntTemplateNotFoundError);
  });

  it.each(['submitted', 'approved'])('preserves %s and its versions', async (status) => {
    const template = await fixture(status);
    const before = await snapshot(template.id);
    await expect(model.HuntTemplates.deleteCreatorDraft(template.key, creatorId))
      .rejects.toBeInstanceOf(model.HuntTemplateNotDeletableError);
    expect(await snapshot(template.id)).toEqual(before);
  });

  it('rejects another owner without changing persisted data', async () => {
    const template = await fixture();
    const before = await snapshot(template.id);
    await expect(model.HuntTemplates.deleteCreatorDraft(template.key, randomUUID()))
      .rejects.toBeInstanceOf(model.HuntTemplateNotFoundError);
    expect(await snapshot(template.id)).toEqual(before);
  });

  it.each(['key', 'snapshot'])('preserves a Hunt depending on the Template through its %s', async (reference) => {
    const template = await fixture('changes_requested');
    const before = await snapshot(template.id);
    const hunt = (await db.query(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status, template_key, template_version, template_snapshot)
       VALUES ($1, $2, 'Protected Hunt', 'finished', $3, 1, $4) RETURNING *`,
      [organizationId, creatorId, reference === 'key' ? template.key : null, { key: template.key, version: 1 }],
    )).rows[0];
    await expect(model.HuntTemplates.deleteCreatorDraft(template.key, creatorId))
      .rejects.toBeInstanceOf(model.HuntTemplateInUseError);
    expect(await snapshot(template.id)).toEqual(before);
    expect((await db.query('SELECT * FROM hunts WHERE id = $1', [hunt.id])).rows).toEqual([hunt]);
  });

  it.each([false, true])('rolls back a protected version FK failure (deferred=%s)', async (deferred) => {
    const template = await fixture('changes_requested');
    const before = await snapshot(template.id);
    // Force a genuine PostgreSQL failure, including at COMMIT after cascading DELETE.
    // This table exists only inside the disposable database, never the application schema.
    const table = deferred ? 'protected_deferred_version' : 'protected_immediate_version';
    await db.query(`CREATE TABLE ${table} (
      version_id UUID REFERENCES hunt_template_versions(id) ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : 'ON DELETE RESTRICT'}
    )`);
    await db.query(`INSERT INTO ${table} VALUES ($1)`, [before.versions[0].id]);
    await expect(model.HuntTemplates.deleteCreatorDraft(template.key, creatorId))
      .rejects.toBeInstanceOf(model.HuntTemplateInUseError);
    expect(await snapshot(template.id)).toEqual(before);
    expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([{ version_id: before.versions[0].id }]);
    await db.query(`DROP TABLE ${table}`);
    // The failed transaction returned a usable pooled connection and released its locks.
    await model.HuntTemplates.deleteCreatorDraft(template.key, creatorId);
    expect(await snapshot(template.id)).toEqual({ templates: [], versions: [] });
  });
});
