import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import classification from './migrations/022_template_classification.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const databaseName = `c1_${randomUUID().replaceAll('-', '')}`;

suite('C1 PostgreSQL classification and legacy compatibility', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let created = false;
  let applicationPool: Pool | undefined;
  let model: typeof import('../models/HuntTemplate.js');
  let app: ReturnType<typeof import('../app.js')['createApp']>;
  let auth: string;
  let owner: string;
  let localOwner: string;
  let reviewer: string;
  let organization: string;
  let legacy: string;
  let before: unknown;
  const migrations: Migration[] = [];

  const user = async (role: string) => {
    const id = (await db.query('INSERT INTO users (email, role) VALUES ($1, $2) RETURNING id', [`${randomUUID()}@example.com`, role])).rows[0].id;
    await db.query('INSERT INTO user_roles VALUES ($1, $2)', [id, role]);
    return id;
  };
  const identity = async (category: string | null, creator = owner, source?: { id: string; version: number; owner: string }) => {
    const key = `c1-${randomUUID()}`;
    return (await db.query(`INSERT INTO hunt_templates
      (key, origin, created_by_user_id, status, category, source_template_id, source_version, source_creator_user_id, source_review_decision)
      VALUES ($1, 'creator', $2, 'draft', $3, $4, $5, $6, $7) RETURNING *`,
    [key, creator, category, source?.id ?? null, source?.version ?? null, source?.owner ?? null, source ? 'approved' : null])).rows[0];
  };
  const version = async (id: string, category: string | null, creator = owner, number = 1, content = { key: 'independent-content', version: number, configuration: {}, checkpoints: [] as unknown[] }) =>
    (await db.query(`INSERT INTO hunt_template_versions
      (template_id, version, content, origin, created_by_user_id, category)
      VALUES ($1, $2, $3, 'creator', $4, $5) RETURNING *`,
    [id, number, content, creator, category])).rows[0];
  const approve = async (id: string, number = 1) => {
    await db.query("UPDATE hunt_templates SET status='approved', submitted_version=$2 WHERE id=$1", [id, number]);
    await db.query("INSERT INTO hunt_template_reviews (template_id, version, reviewer_user_id, decision) VALUES ($1, $2, $3, 'approved')", [id, number, reviewer]);
  };
  const historical = async () => ({
    templates: (await db.query(`SELECT id, key, origin, created_by_user_id, status, submitted_version, created_at, updated_at FROM hunt_templates ORDER BY id`)).rows,
    versions: (await db.query(`SELECT id, template_id, version, content, origin, created_by_user_id, created_at FROM hunt_template_versions ORDER BY id`)).rows,
    reviews: (await db.query('SELECT * FROM hunt_template_reviews ORDER BY template_id, version')).rows,
    hunts: (await db.query('SELECT * FROM hunts ORDER BY id')).rows,
  });
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('./pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('./migrations/', import.meta.url);
      for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name) && !name.startsWith('022')).sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
      owner = await user('creator'); localOwner = await user('creator'); reviewer = await user('admin');
      organization = (await db.query("INSERT INTO organizations (name, owner_id) VALUES ('C1', $1) RETURNING id", [localOwner])).rows[0].id;
      legacy = (await db.query("INSERT INTO hunt_templates (key, origin, created_by_user_id, status) VALUES ('c1-legacy', 'creator', $1, 'draft') RETURNING id", [owner])).rows[0].id;
      for (const number of [1, 2]) await db.query(`INSERT INTO hunt_template_versions (template_id, version, content, origin, created_by_user_id)
        VALUES ($1, $2, $3, 'creator', $4)`, [legacy, number, { key: 'c1-legacy', version: number }, owner]);
      await approve(legacy);
      await db.query(`INSERT INTO hunts (organization_id, created_by_user_id, name, status, template_key, template_version, template_snapshot)
        VALUES ($1, $2, 'Historical', 'finished', 'c1-legacy', 1, $3)`, [organization, localOwner, { key: 'c1-legacy', version: 1, frozen: 'snapshot' }]);
      before = await historical();
      migrations.push(classification);
      await runMigrations(client, migrations);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    applicationPool = (await import('../lib/postgres.js')).pool;
    model = await import('../models/HuntTemplate.js');
    app = (await import('../app.js')).createApp();
    auth = `Bearer ${(await import('../lib/jwt.js')).signJwt({ sub: localOwner, type: 'access' })}`;
    await db.query("INSERT INTO user_roles VALUES ($1, 'organizer')", [localOwner]);
  }, 30_000);
  afterAll(async () => {
    await applicationPool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it('preserves all legacy bytes, pins, reviews, Signal and Hunt snapshots through migration and rerun', async () => {
    expect(await historical()).toEqual(before);
    expect((await db.query('SELECT DISTINCT category FROM hunt_templates')).rows).toEqual([{ category: null }]);
    expect((await db.query('SELECT DISTINCT category FROM hunt_template_versions')).rows).toEqual([{ category: null }]);
    const client = await db.connect();
    try { expect(await runMigrations(client, migrations)).toEqual([]); } finally { client.release(); }
    expect((await model.HuntTemplates.findApprovedByKeyWithLatestVersion('c1-legacy'))?.version).toBe(1);
    expect((await model.HuntTemplates.findApprovedByKeyWithLatestVersion('signal-cluj-napoca'))?.version).toBe(1);
  });

  it('binds category on identity and versions and freezes classified owner and content', async () => {
    const t = await identity('universal'); await version(t.id, 'universal');
    for (const sql of ["category='local'", 'category=NULL', `created_by_user_id='${localOwner}'`, "origin='platform'", "key='renamed'"]) {
      await expect(db.query(`UPDATE hunt_templates SET ${sql} WHERE id=$1`, [t.id])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(db.query("UPDATE hunt_templates SET category='local' WHERE id=$1", [legacy])).rejects.toMatchObject({ code: '23514' });
    await expect(version(t.id, null, owner, 2)).rejects.toMatchObject({ code: '23514' });
    await expect(version(t.id, 'local', owner, 2)).rejects.toMatchObject({ code: '23514' });
    await expect(version(t.id, 'universal', localOwner, 2)).rejects.toMatchObject({ code: '23514' });
    await version(t.id, 'universal', owner, 2);
    await expect(db.query("UPDATE hunt_template_versions SET content='{}' WHERE template_id=$1", [t.id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('UPDATE hunt_template_versions SET template_id=$1 WHERE template_id=$2', [t.id, legacy])).rejects.toMatchObject({ code: '23514' });
    await expect(identity('bogus')).rejects.toMatchObject({ code: '23514' });
    await expect(db.query("INSERT INTO hunt_templates (key, origin, status, category) VALUES ($1, 'platform', 'draft', 'local')", [randomUUID()])).rejects.toMatchObject({ code: '23514' });
  });

  it('retains exact approved Universal lineage while Local owner/content/history stay independent', async () => {
    const source = await identity('universal'); const original = await version(source.id, 'universal'); await approve(source.id);
    const ref = { id: source.id, version: 1, owner };
    const local = await identity('local', localOwner, ref);
    const localV1 = await version(local.id, 'local', localOwner, 1, { key: local.key, version: 1, configuration: { adapted: true }, checkpoints: [] });
    await version(local.id, 'local', localOwner, 2);
    expect(local.created_by_user_id).toBe(localOwner); expect(local.source_creator_user_id).toBe(owner);
    expect(localV1.content).not.toEqual(original.content);
    for (const sql of ['source_template_id=NULL, source_version=NULL, source_creator_user_id=NULL, source_review_decision=NULL', 'source_version=2']) {
      await expect(db.query(`UPDATE hunt_templates SET ${sql} WHERE id=$1`, [local.id])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(identity('universal', localOwner, ref)).rejects.toMatchObject({ code: '23514' });
    await expect(identity('local', localOwner, { ...ref, owner: localOwner })).rejects.toMatchObject({ code: '23514' });
    await expect(identity('local', localOwner, { ...ref, version: 99 })).rejects.toMatchObject({ code: '23503' });
    await expect(identity('local', localOwner, { ...ref, id: local.id, owner: localOwner })).rejects.toMatchObject({ code: '23514' });
    await expect(db.query("INSERT INTO hunt_templates (key, origin, created_by_user_id, status, source_version) VALUES ($1, 'creator', $2, 'draft', 1)", [randomUUID(), owner])).rejects.toMatchObject({ code: '23514' });
    await expect(identity('local', localOwner, { ...ref, id: legacy })).rejects.toMatchObject({ code: '23514' });
    const unapproved = await identity('universal'); await version(unapproved.id, 'universal');
    await expect(identity('local', localOwner, { ...ref, id: unapproved.id })).rejects.toMatchObject({ code: '23503' });
    await expect(db.query('DELETE FROM hunt_templates WHERE id=$1', [source.id])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query('DELETE FROM hunt_template_versions WHERE template_id=$1', [source.id])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query("UPDATE hunt_template_reviews SET decision='changes_requested' WHERE template_id=$1", [source.id])).rejects.toMatchObject({ code: '23503' });
    await version(source.id, 'universal', owner, 2);
    expect((await db.query('SELECT * FROM hunt_template_versions WHERE id=$1', [localV1.id])).rows[0]).toEqual(localV1);
    await model.HuntTemplates.deleteCreatorDraft(local.key, localOwner);
    expect((await db.query('SELECT * FROM hunt_templates WHERE id=$1', [local.id])).rows).toEqual([]);
  });

  it.each(['universal', 'local'])('keeps approved %s out of catalog, geography and direct-key Hunt selection', async category => {
    const t = await identity(category); await version(t.id, category); await approve(t.id);
    expect(await model.HuntTemplates.findApprovedByKeyWithLatestVersion(t.key)).toBeNull();
    expect((await model.HuntTemplates.listApprovedWithLatestVersion()).map(t => t.key)).not.toContain(t.key);
    const catalog = await request(app).get('/api/hunt-templates').set('Authorization', auth).expect(200);
    expect(catalog.body.map((t: { key: string }) => t.key)).not.toContain(t.key);
    await request(app).get(`/api/hunt-templates/${t.key}/geography`).set('Authorization', auth).expect(404);
    const hunt = (await db.query(`INSERT INTO hunts (organization_id, created_by_user_id, name, status)
      VALUES ($1, $2, 'C1 draft', 'draft') RETURNING id`, [organization, localOwner])).rows[0].id;
    await db.query("INSERT INTO hunt_roles VALUES ($1, $2, 'organizer')", [hunt, localOwner]);
    const response = await request(app).patch(`/api/hunts/${hunt}`).set('Authorization', auth).send({ templateKey: t.key });
    expect(response.status).toBe(400);
    expect((await db.query('SELECT template_key, template_version, template_snapshot FROM hunts WHERE id=$1', [hunt])).rows[0])
      .toEqual({ template_key: null, template_version: null, template_snapshot: null });
  });

  it('retires attributed accounts without altering classified ownership, lineage or saved Hunts', async () => {
    const sourceOwner = await user('creator'); const destinationOwner = await user('creator');
    const source = await identity('universal', sourceOwner); await version(source.id, 'universal', sourceOwner); await approve(source.id);
    const local = await identity('local', destinationOwner, { id: source.id, version: 1, owner: sourceOwner });
    await version(local.id, 'local', destinationOwner);
    const saved = await historical();
    const { User } = await import('../models/User.js');
    expect(await User.deleteControlled(sourceOwner)).toBe('retired');
    expect(await User.deleteControlled(destinationOwner)).toBe('retired');
    expect(await historical()).toEqual(saved);
    expect((await db.query('SELECT account_status, email FROM users WHERE id=ANY($1::uuid[])', [[sourceOwner, destinationOwner]])).rows)
      .toEqual([{ account_status: 'retired', email: null }, { account_status: 'retired', email: null }]);
  });

  it('accepts a fresh schema baseline with equivalent classification constraints', async () => {
    const client = await db.connect();
    const constraints = `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
      WHERE n.nspname=current_schema() AND
        (c.conname LIKE '%category%' OR c.conname LIKE 'hunt_templates_source%' OR
         c.conname IN ('hunt_templates_classified_owner_check', 'hunt_template_reviews_exact_decision_key'))
      ORDER BY c.conname`;
    const migratedConstraints = (await client.query(constraints)).rows;
    try {
      await client.query('BEGIN; CREATE SCHEMA baseline_c1; SET LOCAL search_path TO baseline_c1, public');
      await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
      expect((await client.query(constraints)).rows).toEqual(migratedConstraints);
      expect((await client.query("SELECT tgname FROM pg_trigger WHERE tgrelid IN ('hunt_templates'::regclass, 'hunt_template_versions'::regclass) AND NOT tgisinternal ORDER BY tgname")).rows)
        .toEqual([{ tgname: 'hunt_template_versions_identity_binding' }, { tgname: 'hunt_templates_identity_binding' }]);
      await expect(client.query("INSERT INTO hunt_templates (key, origin, status, category) VALUES ('bad', 'platform', 'draft', 'local')"))
        .rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
