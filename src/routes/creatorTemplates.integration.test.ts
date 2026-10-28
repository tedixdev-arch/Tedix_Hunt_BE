import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `c2_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;
const root = '/api/creator/templates';
const snapshot = (key: string, version = 1, geographic = false) => ({
  key, version, displayName: 'Scratch puzzle', theme: 'Explore',
  mission: { name: 'Find the code' }, scoring: { startingScore: 100 },
  configuration: geographic ? {
    normalCheckpointCount: 1,
    checkpointPositions: [{ checkpointNumber: 1, name: 'Square', latitude: 46.77, longitude: 23.62, radiusMeters: 30 }],
    finishPoint: { name: 'Finish', latitude: 46.78, longitude: 23.63, radiusMeters: 5 },
  } : { durationMinutes: 45 },
  checkpoints: [{ checkpoint: 1, kind: 'hidden-rule' }, { role: 'terminal', navigationMode: 'none' }],
});

type Actor = { id: string; auth: string };
suite('C2 scratch authoring against disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let applicationPool: Pool | undefined;
  let created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  let model: typeof import('../models/HuntTemplate.js');
  let owner: Actor;
  let other: Actor;
  let reviewer: Actor;
  const actor = async (roles: string[], options: { guest?: boolean; status?: string } = {}): Promise<Actor> => {
    const id = (await db.query(`INSERT INTO users (email, role, is_guest, account_status)
      VALUES ($1, 'participant', $2, $3) RETURNING id`,
    [`${randomUUID()}@example.invalid`, options.guest ?? false, options.status ?? 'active'])).rows[0].id;
    for (const role of roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, role]);
    return { id, auth: `Bearer ${signJwt({ sub: id, type: 'access', role: 'creator' })}` };
  };
  const post = (path: string, body: object, who = owner) => request(app).post(path).set('Authorization', who.auth).send(body);
  const create = async (category?: string, geographic = category === 'local', who = owner) => {
    const key = `c2-${randomUUID()}`;
    const content = snapshot(key, 1, geographic);
    const response = await post(root, { key, content, ...(category ? { category } : {}) }, who).expect(201);
    return { key, content, response };
  };
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name)).sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    applicationPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); signJwt = (await import('../lib/jwt.js')).signJwt;
    model = await import('../models/HuntTemplate.js');
    owner = await actor(['creator', 'admin']); other = await actor(['creator']); reviewer = await actor(['admin']);
  }, 30_000);
  afterAll(async () => {
    await applicationPool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it('C4 copies exact published snapshots with independent ownership, immutable lineage and Local review gates', async () => {
    const source = await create('universal', false);
    const sourceId = (await model.HuntTemplates.findByKey(source.key))!.id;
    const reference = { templateId: sourceId, version: 1 };
    const copy = (key: string, who = other, publishedReference = reference, extra = {}) =>
      post(`${root}/from-universal/${source.key}`, { key, publishedReference, ...extra }, who);
    for (const state of ['draft', 'submitted', 'changes_requested']) {
      if (state === 'submitted') await post(`${root}/${source.key}/submit`, { version: 1 }).expect(200);
      if (state === 'changes_requested') {
        await db.query("UPDATE hunt_templates SET status='changes_requested' WHERE id=$1", [sourceId]);
      }
      await copy(`c4-${randomUUID()}`).expect(404);
    }
    await db.query("UPDATE hunt_templates SET status='submitted' WHERE id=$1", [sourceId]);
    await post(`/api/admin/templates/review/${source.key}/approve`, {}, reviewer).expect(200);
    const before = (await db.query('SELECT * FROM hunt_templates WHERE id=$1', [sourceId])).rows[0];
    const sourceVersion = await model.HuntTemplates.getVersion(sourceId, 1);
    await copy(`c4-${randomUUID()}`, other, { ...reference, version: 2 }).expect(409);
    await copy(`c4-${randomUUID()}`, other, { ...reference, templateId: randomUUID() }).expect(409);
    for (const field of ['category', 'status', 'owner', 'source_template_id', 'approval']) {
      await copy(`c4-${randomUUID()}`, other, reference, { [field]: 'forged' }).expect(400);
    }
    const key = `c4-${randomUUID()}`;
    const response = await copy(key).expect(201);
    expect(response.body).toEqual({ key, version: 1, category: 'local', origin: 'creator', status: 'draft', content: { ...source.content, key, version: 1 } });
    const local = (await db.query('SELECT * FROM hunt_templates WHERE key=$1', [key])).rows[0];
    expect(local.id).not.toBe(sourceId);
    expect(local).toMatchObject({ created_by_user_id: other.id, category: 'local', status: 'draft', submitted_version: null,
      source_template_id: sourceId, source_version: 1, source_creator_user_id: owner.id, source_review_decision: 'approved' });
    await copy(key).expect(409);
    expect((await db.query('SELECT * FROM hunt_template_versions WHERE template_id=$1', [local.id])).rows).toHaveLength(1);
    await copy(`c4-${randomUUID()}`, owner).expect(201);
    await post(`${root}/${key}/submit`, { version: 1 }, other).expect(400);
    const adapted = { ...snapshot(key, 2, true), displayName: 'Independent Local' };
    await post(`${root}/${key}/versions`, { content: adapted }, other).expect(201);
    expect(await model.HuntTemplates.getVersion(sourceId, 1)).toEqual(sourceVersion);
    expect((await db.query('SELECT * FROM hunt_templates WHERE id=$1', [sourceId])).rows[0]).toEqual(before);
    // Simulate a future source version only through SQL: C5 authoring is out of scope.
    await db.query(`INSERT INTO hunt_template_versions (template_id,version,content,origin,category,created_by_user_id)
      VALUES ($1,2,$2,'creator','universal',$3)`, [sourceId, { ...source.content, version: 2, displayName: 'Later Universal' }, owner.id]);
    expect((await model.HuntTemplates.getVersion(local.id, 1))!.content).toEqual(response.body.content);
    expect((await model.HuntTemplates.getVersion(local.id, 2))!.content).toEqual(adapted);
    await post(`${root}/${key}/submit`, { version: 2 }, other).expect(200);
    expect(await model.HuntTemplates.findApprovedByKeyWithLatestVersion(key)).toBeNull();
    await post(`/api/admin/templates/review/${key}/approve`, {}, other).expect(403);
    await post(`/api/admin/templates/review/${key}/approve`, {}, reviewer).expect(200);
    expect(await model.HuntTemplates.findApprovedByKeyWithLatestVersion(key)).toBeNull();
    for (const category of ['local', undefined]) {
      const invalid = await create(category);
      await post(`${root}/from-universal/${invalid.key}`, { key: `c4-${randomUUID()}`, publishedReference: reference }, other).expect(404);
    }
    for (const roles of [[], ['admin'], ['organizer'], ['participant']]) {
      await copy(`c4-${randomUUID()}`, await actor(roles)).expect(403);
    }
    for (const options of [{ guest: true }, { status: 'blocked' }, { status: 'retired' }]) {
      await copy(`c4-${randomUUID()}`, await actor(['creator'], options)).expect(options.guest ? 403 : 401);
    }
    await request(app).post(`${root}/from-universal/${source.key}`).send({ key, publishedReference: reference }).expect(401);
    await db.query('DELETE FROM hunt_template_reviews WHERE template_id=$1', [sourceId]).then(
      () => { throw new Error('Expected provenance dependency restriction'); }, () => undefined);
  });

  it('C4 preserves optional geography as draft, rejects nonpublished sources, serializes keys and rolls back insert failures', async () => {
    const source = await create('universal', true);
    const id = (await model.HuntTemplates.findByKey(source.key))!.id;
    const copy = (key: string) => post(`${root}/from-universal/${source.key}`, {
      key, publishedReference: { templateId: id, version: 1 },
    }, other);
    await post(`${root}/${source.key}/submit`, { version: 1 }).expect(200);
    await db.query("UPDATE hunt_templates SET status='approved' WHERE id=$1", [id]);
    await copy(`c4-${randomUUID()}`).expect(404); // Historical status lacks exact decision.
    await db.query("UPDATE hunt_templates SET status='submitted' WHERE id=$1", [id]);
    await post(`/api/admin/templates/review/${source.key}/approve`, {}, reviewer).expect(200);
    const key = `c4-${randomUUID()}`;
    const results = await Promise.all([copy(key), copy(key)]);
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    expect(results.find(result => result.status === 201)!.body.content.configuration).toEqual(source.content.configuration);
    const local = (await model.HuntTemplates.findByKey(key))!;
    await post(`${root}/${key}/submit`, { version: 1 }, other).expect(200);
    await post(`/api/admin/templates/review/${key}/approve`, {}, reviewer).expect(200);
    await post(`${root}/from-universal/${key}`, { key: `c4-${randomUUID()}`, publishedReference: { templateId: local.id, version: 1 } }, other).expect(404);
    const failedKey = `c4-${randomUUID()}`;
    await db.query(`CREATE FUNCTION c4_fail_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.content->>'key' = '${failedKey}' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER c4_fail_version BEFORE INSERT ON hunt_template_versions FOR EACH ROW EXECUTE FUNCTION c4_fail_version()`);
    try {
      await copy(failedKey).expect(500);
      expect(await model.HuntTemplates.findByKey(failedKey)).toBeNull();
    } finally {
      await db.query('DROP TRIGGER c4_fail_version ON hunt_template_versions; DROP FUNCTION c4_fail_version()');
    }
  });

  it.each(['universal', 'local'])('creates, saves, pins, reviews and isolates %s', async category => {
    const { key, content, response } = await create(category);
    expect(response.body.category).toBe(category);
    const id = (await model.HuntTemplates.findByKey(key))!.id;
    const v1 = await model.HuntTemplates.getVersion(id, 1);
    const v2 = { ...content, version: 2, displayName: 'Saved revision' };
    await post(`${root}/${key}/versions`, { content: v2 }).expect(201);
    expect(await model.HuntTemplates.getVersion(id, 1)).toEqual(v1);
    expect((await db.query(`SELECT category, origin, created_by_user_id FROM hunt_template_versions
      WHERE template_id=$1 ORDER BY version`, [id])).rows).toEqual([1, 2].map(() => ({ category, origin: 'creator', created_by_user_id: owner.id })));
    expect((await db.query('SELECT source_template_id, source_version, source_creator_user_id, source_review_decision FROM hunt_templates WHERE id=$1', [id])).rows[0])
      .toEqual({ source_template_id: null, source_version: null, source_creator_user_id: null, source_review_decision: null });
    await request(app).get(`${root}/${key}`).set('Authorization', other.auth).expect(404);
    await post(`${root}/${key}/versions`, { content: { ...v2, version: 3 } }, other).expect(404);
    await post(`${root}/${key}/submit`, { version: 2 }, other).expect(404);
    await post(`${root}/${key}/submit`, { version: 1 }).expect(409);
    await post(`${root}/${key}/submit`, { version: 2 }).expect(200);
    const review = await request(app).get(`/api/admin/templates/review/${key}`).set('Authorization', reviewer.auth).expect(200);
    expect(review.body).toMatchObject({ category, version: 2, content: v2 });
    await post(`/api/admin/templates/review/${key}/approve`, {}).expect(403);
    expect((await db.query('SELECT * FROM hunt_template_reviews WHERE template_id=$1', [id])).rows).toHaveLength(0);
    await post(`/api/admin/templates/review/${key}/approve`, {}, reviewer).expect(200);
    expect((await db.query('SELECT version, reviewer_user_id, decision FROM hunt_template_reviews WHERE template_id=$1', [id])).rows)
      .toEqual([{ version: 2, reviewer_user_id: reviewer.id, decision: 'approved' }]);
    await post(`${root}/${key}/versions`, { content: { ...v2, version: 3 } }).expect(409);
    expect((await model.HuntTemplates.findByKey(key))?.submittedVersion).toBe(2);
    expect(await model.HuntTemplates.findApprovedByKeyWithLatestVersion(key)).toBeNull();
    const catalog = await request(app).get('/api/hunt-templates').set('Authorization', owner.auth).expect(200);
    expect(catalog.body.some((item: { key: string }) => item.key === key)).toBe(false);
    await request(app).get(`/api/hunt-templates/${key}/geography`).set('Authorization', owner.auth).expect(404);
    await db.query("INSERT INTO user_roles VALUES ($1, 'organizer') ON CONFLICT DO NOTHING", [owner.id]);
    const organization = (await db.query("INSERT INTO organizations (name, owner_id) VALUES ('C2', $1) RETURNING id", [owner.id])).rows[0].id;
    const hunt = (await db.query("INSERT INTO hunts (organization_id, created_by_user_id, name, status) VALUES ($1, $2, 'C2', 'draft') RETURNING id", [organization, owner.id])).rows[0].id;
    await db.query("INSERT INTO hunt_roles VALUES ($1, $2, 'organizer')", [hunt, owner.id]);
    await request(app).patch(`/api/hunts/${hunt}`).set('Authorization', owner.auth).send({ templateKey: key }).expect(400);
    expect((await db.query('SELECT template_key FROM hunts WHERE id=$1', [hunt])).rows[0].template_key).toBeNull();
  });

  it('submits Universal counted gameplay without route geography but keeps gameplay completeness', async () => {
    const { key, content } = await create('universal');
    await post(`${root}/${key}/versions`, { content: { ...content, version: 2, configuration: { normalCheckpointCount: 1 } } }).expect(201);
    await post(`${root}/${key}/submit`, { version: 2 }).expect(200);
    const incomplete = await create('universal');
    await post(`${root}/${incomplete.key}/versions`, { content: { ...incomplete.content, version: 2, configuration: { normalCheckpointCount: 2 } } }).expect(201);
    await post(`${root}/${incomplete.key}/submit`, { version: 2 }).expect(400);
  });

  it.each(['missing-contract', 'missing-positions', 'missing-finish', 'missing-gameplay'])('rejects incomplete Local %s without pinning', async missing => {
    const key = `c2-${randomUUID()}`;
    const content: any = snapshot(key, 1, true);
    if (missing === 'missing-contract') content.configuration = { durationMinutes: 45 };
    if (missing === 'missing-positions') content.configuration.checkpointPositions = [];
    if (missing === 'missing-finish') delete content.configuration.finishPoint;
    if (missing === 'missing-gameplay') content.checkpoints = [{ checkpoint: 1 }];
    await post(root, { key, category: 'local', content }).expect(201);
    await post(`${root}/${key}/submit`, { version: 1 }).expect(400);
    expect(await model.HuntTemplates.findByKey(key)).toMatchObject({ status: 'draft', submittedVersion: null });
  });

  it('rejects metadata injection, invalid category, malformed geography and unsupported gameplay', async () => {
    const { key, content } = await create('local');
    for (const metadata of [{ category: 'universal' }, { createdByUserId: other.id }, { sourceTemplateId: key }, { source_version: 1 }, { origin: 'platform' }]) {
      await post(`${root}/${key}/versions`, { content: { ...content, version: 2 }, ...metadata }).expect(400);
      await post(`${root}/${key}/versions`, { content: { ...content, version: 2, ...metadata } }).expect(400);
      const newKey = `c2-${randomUUID()}`;
      await post(root, { key: newKey, category: 'local', content: { ...content, key: newKey, ...metadata } }).expect(400);
    }
    for (const category of [null, 'other', '', 1]) {
      await post(root, { key, content, category }).expect(400);
    }
    const newKey = `c2-${randomUUID()}`;
    await post(root, { key: newKey, category: 'universal', content: { ...snapshot(newKey), configuration: { normalCheckpointCount: 1 }, checkpoints: [{ kind: 'unsupported' }] } }).expect(400);
    await post(`${root}/${key}/versions`, { content: { ...content, version: 2, configuration: { normalCheckpointCount: 1, finishPoint: { latitude: 999 } } } }).expect(400);
    expect((await model.HuntTemplates.getLatestVersion((await model.HuntTemplates.findByKey(key))!.id))?.version).toBe(1);
  });

  it('uses persisted active Creator capabilities rather than JWT or primary-role claims', async () => {
    for (const roles of [[], ['participant'], ['admin'], ['organizer']]) {
      const who = await actor(roles); const key = `c2-${randomUUID()}`;
      await post(root, { key, category: 'universal', content: snapshot(key) }, who).expect(403);
    }
    for (const options of [{ guest: true }, { status: 'blocked' }, { status: 'retired' }]) {
      const who = await actor(['creator'], options); const key = `c2-${randomUUID()}`;
      await post(root, { key, category: 'local', content: snapshot(key) }, who).expect(options.guest ? 403 : 401);
    }
    const who = await actor(['creator']); await create('universal', false, who);
    await db.query('DELETE FROM user_roles WHERE user_id=$1', [who.id]);
    const key = `c2-${randomUUID()}`;
    await post(root, { key, category: 'universal', content: snapshot(key) }, who).expect(403);
    await request(app).post(root).send({ key, category: 'local', content: snapshot(key) }).expect(401);
  });

  it('keeps omitted-category scratch and Signal starters unclassified', async () => {
    const { key } = await create();
    await post(`${root}/${key}/submit`, { version: 1 }).expect(200);
    expect((await model.HuntTemplates.findByKey(key))?.category).toBeNull();
    for (const starter of ['signal-cluj-napoca', 'signal-overload-cluj-napoca']) {
      const response = await post(`${root}/starters/${starter}`, {}).expect(201);
      expect(response.body).not.toHaveProperty('category');
      const t = (await model.HuntTemplates.findByKey(response.body.key))!;
      expect(t.category).toBeNull();
      expect((await model.HuntTemplates.getVersion(t.id, 1))?.category).toBeNull();
    }
    expect((await model.HuntTemplates.findByKey('signal-cluj-napoca'))?.category).toBeNull();
    expect((await model.HuntTemplates.findApprovedByKeyWithLatestVersion('signal-cluj-napoca'))?.version).toBe(1);
  });
  it('publishes only independently approved Universals, once, at the exact pin', async () => {
    const library = '/api/creator/universal-library';
    const get = (path: string, who = other) => request(app).get(path).set('Authorization', who.auth);
    const universal = await create('universal');
    const key = universal.key;
    await db.query('UPDATE users SET name=$1 WHERE id=$2', ['Original Creator', owner.id]);
    await get(`${library}/${key}`).expect(404);
    const approved = { ...universal.content, version: 2, displayName: 'Published puzzle' };
    await post(`${root}/${key}/versions`, { content: approved }).expect(201);
    await post(`${root}/${key}/submit`, { version: 2 }).expect(200);
    await get(`${library}/${key}`).expect(404);
    await post(`/api/admin/templates/review/${key}/approve`, {}).expect(403);
    await get(`${library}/${key}`).expect(404);
    await post(`/api/admin/templates/review/${key}/approve`, {}, reviewer).expect(200);
    const identity = (await model.HuntTemplates.findByKey(key))!;
    // Internal extra version proves the library never substitutes MAX(version).
    await db.query(`INSERT INTO hunt_template_versions
      (template_id, version, content, origin, category, created_by_user_id)
      VALUES ($1, 3, $2, 'creator', 'universal', $3)`,
    [identity.id, { ...approved, version: 3, displayName: 'Unapproved extra' }, owner.id]);
    const expected = {
      id: identity.id, key, displayName: 'Published puzzle', theme: approved.theme,
      creator: { id: owner.id, name: 'Original Creator' },
      publishedReference: { templateId: identity.id, version: 2 },
    };
    for (const who of [owner, other, await actor(['creator', 'organizer'])]) {
      const list = await get(library, who).expect(200);
      expect(list.body.items.filter((item: { key: string }) => item.key === key)).toEqual([expected]);
      expect((await get(`${library}/${key}`, who).expect(200)).body).toEqual({ ...expected, content: approved });
    }
    // A query parameter cannot turn discovery into a historical-version chooser.
    expect((await get(`${library}/${key}?version=1`).expect(200)).body.content).toEqual(approved);
    await get(`${root}/${key}`).expect(404);
    const changes = await create('universal');
    await post(`${root}/${changes.key}/submit`, { version: 1 }).expect(200);
    await post(`/api/admin/templates/review/${changes.key}/request-changes`, {}, reviewer).expect(200);
    await get(`${library}/${changes.key}`).expect(404);
    for (const category of ['local', undefined]) {
      const excluded = await create(category);
      await post(`${root}/${excluded.key}/submit`, { version: 1 }).expect(200);
      await post(`/api/admin/templates/review/${excluded.key}/approve`, {}, reviewer).expect(200);
      await get(`${library}/${excluded.key}`).expect(404);
    }
    // Status without an exact independent review record is insufficient authority.
    const historical = await create('universal');
    await db.query("UPDATE hunt_templates SET status='approved', submitted_version=1 WHERE key=$1", [historical.key]);
    await get(`${library}/${historical.key}`).expect(404);
    const list = (await get(library).expect(200)).body.items;
    expect(list.some((item: { key: string }) => [changes.key, historical.key, 'signal-cluj-napoca'].includes(item.key))).toBe(false);
    for (const who of [reviewer, await actor([]), await actor(['participant']), await actor(['organizer']),
      await actor(['creator'], { guest: true }), await actor(['creator'], { status: 'blocked' }),
      await actor(['creator'], { status: 'retired' })]) {
      const status = [reviewer.id].includes(who.id) ? 403 : undefined;
      for (const path of [library, `${library}/${key}`]) {
        const response = await get(path, who);
        expect(status ? response.status === status : [401, 403].includes(response.status)).toBe(true);
      }
    }
    const revoked = await actor(['creator']);
    await db.query('DELETE FROM user_roles WHERE user_id=$1', [revoked.id]);
    for (const path of [library, `${library}/${key}`]) {
      await get(path, revoked).expect(403);
      await request(app).get(path).expect(401);
    }
  });

});
