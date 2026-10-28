import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import publication from './migrations/023_template_publication.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const databaseName = `c5_migration_${randomUUID().replaceAll('-', '')}`;

suite('C5 publication migration on existing C4 data', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let created = false;
  const migrations: Migration[] = [];
  let creator: string;
  let reviewer: string;
  const ids: Record<string, string> = {};
  let before: unknown;
  const history = async () => ({
    templates: (await db.query(`SELECT id,key,origin,category,created_by_user_id,status,submitted_version,
      source_template_id,source_version,source_creator_user_id,source_review_decision,created_at,updated_at
      FROM hunt_templates ORDER BY id`)).rows,
    versions: (await db.query('SELECT * FROM hunt_template_versions ORDER BY id')).rows,
    reviews: (await db.query('SELECT * FROM hunt_template_reviews ORDER BY template_id,version')).rows,
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
      for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name) && name < '023').sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
    } finally { client.release(); }
    creator = (await db.query("INSERT INTO users (email,role) VALUES ('creator@c5.invalid','creator') RETURNING id")).rows[0].id;
    reviewer = (await db.query("INSERT INTO users (email,role) VALUES ('admin@c5.invalid','admin') RETURNING id")).rows[0].id;
    for (const kind of ['approved', 'evidence-free', 'self-approved', 'submitted', 'local', 'legacy']) {
      const category = kind === 'legacy' ? null : kind === 'local' ? 'local' : 'universal';
      const id = (await db.query(`INSERT INTO hunt_templates (key,origin,created_by_user_id,status,category)
        VALUES ($1,'creator',$2,'draft',$3) RETURNING id`, [`c5-${kind}`, creator, category])).rows[0].id;
      ids[kind] = id;
      for (const version of [1, 2]) await db.query(`INSERT INTO hunt_template_versions
        (template_id,version,content,origin,category,created_by_user_id) VALUES ($1,$2,$3,'creator',$4,$5)`,
      [id, version, { key: `c5-${kind}`, version, displayName: kind }, category, creator]);
      await db.query('UPDATE hunt_templates SET status=$2,submitted_version=1 WHERE id=$1', [id, kind === 'submitted' ? 'submitted' : 'approved']);
      if (!['evidence-free', 'submitted'].includes(kind)) await db.query(`INSERT INTO hunt_template_reviews
        (template_id,version,reviewer_user_id,decision) VALUES ($1,1,$2,'approved')`, [id, kind === 'self-approved' ? creator : reviewer]);
    }
    const organization = (await db.query("INSERT INTO organizations (name,owner_id) VALUES ('C5 history',$1) RETURNING id", [creator])).rows[0].id;
    await db.query(`INSERT INTO hunts (organization_id,created_by_user_id,name,status,template_key,template_version,template_snapshot)
      VALUES ($1,$2,'Historical Signal snapshot','finished','signal-cluj-napoca',1,$3)`,
    [organization, creator, { key: 'signal-cluj-napoca', version: 1, frozen: 'original bytes' }]);
    before = await history();
  }, 30_000);
  afterAll(async () => {
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it('backfills only evidence-backed approved Universals and preserves every historical field', async () => {
    const client = await db.connect();
    try {
      migrations.push(publication);
      expect(await runMigrations(client, migrations)).toEqual(['023_template_publication']);
      expect(await runMigrations(client, migrations)).toEqual([]);
    } finally { client.release(); }
    expect(await history()).toEqual(before);
    const pins = (await db.query('SELECT key,published_version FROM hunt_templates WHERE published_version IS NOT NULL')).rows;
    expect(pins).toEqual([{ key: 'c5-approved', published_version: 1 }]);
    expect((await db.query("SELECT category,published_version FROM hunt_templates WHERE key='signal-cluj-napoca'")).rows[0])
      .toEqual({ category: null, published_version: null });
    await expect(db.query('UPDATE hunt_templates SET published_version=2 WHERE id=$1', [ids.approved])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('UPDATE hunt_templates SET published_version=1 WHERE id=$1', [ids['self-approved']])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('UPDATE hunt_templates SET published_version=1 WHERE id=$1', [ids.local])).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps fresh-schema publication constraints equivalent to migrated databases', async () => {
    const client = await db.connect();
    const constraints = `SELECT conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=current_schema() AND conname LIKE 'hunt_templates_published_%' ORDER BY conname`;
    try {
      const migrated = (await client.query(constraints)).rows;
      await client.query('BEGIN; CREATE SCHEMA baseline_c5; SET LOCAL search_path TO baseline_c5,public');
      await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
      expect((await client.query(constraints)).rows).toEqual(migrated);
      expect((await client.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND
        tgrelid IN ('hunt_templates'::regclass,'hunt_template_reviews'::regclass) AND
        tgname IN ('hunt_templates_publication_evidence','hunt_template_reviews_immutable_classified') ORDER BY tgname`)).rows)
        .toEqual([{ tgname: 'hunt_template_reviews_immutable_classified' }, { tgname: 'hunt_templates_publication_evidence' }]);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

});
