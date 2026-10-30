import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';
import { customTemplateFixture, exerciseFixtures } from '../test/customExercises.js';
import { createSignalClujNapocaStarter } from '../domain/templates/signalClujNapocaStarter.js';
import { createSignalOverloadClujNapocaStarter } from '../domain/templates/signalOverloadClujNapocaStarter.js';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `custom_exercises_${randomUUID().replaceAll('-', '')}`;
const root = '/api/creator/templates';
type Actor = { id: string; auth: string };
(testUrl ? describe : describe.skip)('Custom exercise API and lifecycle against disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool, applicationPool: Pool | undefined, created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  let model: typeof import('../models/HuntTemplate.js');
  let owner: Actor, other: Actor, reviewer: Actor, participant: Actor, supervisor: Actor;
  let localityId: string, organizationId: string;
  const actor = async (roles: string[]): Promise<Actor> => {
    const id = (await db.query("INSERT INTO users(email,role) VALUES ($1,'participant') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0].id;
    for (const role of roles) await db.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [id, role]);
    return { id, auth: `Bearer ${signJwt({ sub: id, type: 'access' })}` };
  };
  const post = (path: string, body: object, who = owner) => request(app).post(path).set('Authorization', who.auth).send(body);
  const get = (path: string, who = owner) => request(app).get(path).set('Authorization', who.auth);
  const instance = (c: any, checkpoint = 0, slot = 'personal') => c.checkpoints[checkpoint].customExercises[slot];
  const create = async (category?: string, exercises = exerciseFixtures.slice(0, 1)) => {
    const key = `custom-${randomUUID()}`, content = customTemplateFixture(key, 1, exercises);
    if (category === undefined) {
      content.configuration.checkpointPositions = [{ checkpointNumber: 1, name: 'Start', latitude: 46, longitude: 23, radiusMeters: 10 }];
      content.configuration.finishPoint = { name: 'Finish', latitude: 46.1, longitude: 23.1, radiusMeters: 10 };
    }
    const res = await post(root, { key, content, ...(category ? { category } : {}) }).expect(201);
    return { key, content: res.body.content };
  };
  const artifact = async (key: string, version: number) => (await db.query(`SELECT v.content FROM hunt_template_versions v
    JOIN hunt_templates t ON t.id=v.template_id WHERE t.key=$1 AND v.version=$2`, [key, version])).rows[0].content;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url), migrations: Migration[] = [];
      for (const name of (await readdir(directory)).filter(n => /^\d{3}_.*\.ts$/.test(n)).sort()) migrations.push((await import(new URL(name, directory).href)).default);
      const applied = await runMigrations(client, migrations);
      expect(applied).toContain('029_template_custom_exercises');
      expect(await runMigrations(client, migrations)).toEqual([]);
    } finally { client.release(); }
    (await import('../config/environment.js')).environment.databaseUrl = url.toString();
    applicationPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); signJwt = (await import('../lib/jwt.js')).signJwt;
    model = await import('../models/HuntTemplate.js');
    owner = await actor(['creator', 'organizer']); other = await actor(['creator']); reviewer = await actor(['admin']);
    participant = await actor(['participant']); supervisor = await actor(['participant']);
    localityId = (await db.query("INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provenance) VALUES ('RO','Fixture','County',46,23,'Test fixture') RETURNING id")).rows[0].id;
    organizationId = (await db.query("INSERT INTO organizations(name,owner_id) VALUES ('Fixture',$1) RETURNING id", [owner.id])).rows[0].id;
  }, 30000);
  afterAll(async () => {
    app?.locals.stopAbuseProtection?.();
    await applicationPool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  for (const e of exerciseFixtures) it(`${e.type}: real create/read/version round-trip and invalid schema rejection`, async () => {
    const { key, content } = await create('universal', [e]);
    const saved = instance(content, 0, e.classification), { id, owner: binding, ...data } = saved;
    expect(data).toEqual(e); expect(binding).toEqual({ templateKey: key, version: 1 });
    expect((await get(`${root}/${key}`).expect(200)).body.content).toEqual(content);
    const next = structuredClone(content); next.version = 2; instance(next, 0, e.classification).title = 'Edited';
    const res = await post(`${root}/${key}/versions`, { content: next }).expect(201);
    expect(instance(res.body.content, 0, e.classification).id).not.toBe(id);
    expect(instance(res.body.content, 0, e.classification).owner.version).toBe(2);
    expect(await artifact(key, 1)).toEqual(content);
    const invalid = structuredClone(res.body.content); invalid.version = 3; instance(invalid, 0, e.classification).schemaVersion = 9;
    const rejected = await post(`${root}/${key}/versions`, { content: invalid }).expect(400);
    expect(rejected.body.error).toBe('invalid_custom_exercises'); expect(rejected.body.details.length).toBeGreaterThan(0);
    expect((await get(`${root}/${key}`).expect(200)).body.version).toBe(2);
  });
  it('persists independent slots, multiple checkpoints and unnumbered FinishPoint without dropping predefined content', async () => {
    const key = `multi-${randomUUID()}`, input = customTemplateFixture(key, 1, [exerciseFixtures[0], exerciseFixtures[15]]);
    input.configuration.normalCheckpointCount = 2;
    input.checkpoints[0].customExercises.team = structuredClone(exerciseFixtures[21]);
    input.checkpoints.splice(1, 0, { checkpoint: 2, role: 'normal', customExercises: { personal: exerciseFixtures[8] } });
    const content = (await post(root, { key, content: input, category: 'universal' }).expect(201)).body.content;
    expect(content.checkpoints).toHaveLength(3); expect(content.checkpoints[2]).not.toHaveProperty('checkpoint');
    expect(content.checkpoints[0].kind).toBe('hidden-rule'); expect(content.checkpoints[0].arbitrary).toEqual(['legacy preserved']);
    const ids = [instance(content).id, instance(content, 0, 'team').id, instance(content, 1).id, instance(content, 2, 'team').id];
    expect(new Set(ids).size).toBe(4);
    expect((await post(`${root}/${key}/submit`, { version: 1 }).expect(200)).body.content).toEqual(content);
  });
  it('pins submission and approval, independently revises and copies a published Universal into Local', async () => {
    const { key, content } = await create('universal', [exerciseFixtures[1], exerciseFixtures[21]]);
    await post(`${root}/${key}/submit`, { version: 1 }).expect(200);
    await post(`${root}/${key}/versions`, { content: { ...content, version: 2 } }).expect(409);
    const review = await get(`/api/admin/templates/review/${key}`, reviewer).expect(200);
    expect(review.body.content).toEqual(content);
    await post(`/api/admin/templates/review/${key}/approve`, { version: 1 }, reviewer).expect(200);
    const template = await model.HuntTemplates.findByKey(key);
    const destination = `copy-${randomUUID()}`;
    const copied = (await post(`${root}/from-universal/${key}`, { key: destination, publishedReference: { templateId: template!.id, version: 1 } }).expect(201)).body.content;
    expect(instance(copied).owner).toEqual({ templateKey: destination, version: 1 });
    expect(instance(copied).id).not.toBe(instance(content).id);
    expect(instance(copied, 1, 'team').id).not.toBe(instance(content, 1, 'team').id);
    const revision = structuredClone(content); revision.version = 2; instance(revision).instructions = 'Revision only';
    await post(`${root}/${key}/versions`, { content: revision }).expect(201);
    expect(await artifact(key, 1)).toEqual(content);
    expect((await get(`${root}/${key}`).expect(200)).body.publishedVersion).toBe(1);
    for (const version of [1, 2]) await expect(db.query(`UPDATE hunt_template_versions v SET content=content || '{"tampered":true}'::jsonb
      FROM hunt_templates t WHERE t.id=v.template_id AND t.key=$1 AND v.version=$2`, [key, version])).rejects.toMatchObject({ code: '23514' });
    expect(await artifact(destination, 1)).toEqual(copied);
  });
  it('rejects unauthorized, cross-template, stale and moved references without partial versions', async () => {
    const one = await create(), two = await create();
    await post(`${root}/${one.key}/versions`, { content: { ...one.content, version: 2 } }, other).expect(404);
    await post(`${root}/${one.key}/versions`, { content: { ...one.content, version: 2 } }, participant).expect(403);
    await get(`${root}/${one.key}`, other).expect(404);
    await request(app).post(root).send({ key: 'unauthorized', content: customTemplateFixture('unauthorized') }).expect(401);
    const foreign = structuredClone(two.content); foreign.version = 2; foreign.checkpoints[0].customExercises = one.content.checkpoints[0].customExercises;
    await post(`${root}/${two.key}/versions`, { content: foreign }).expect(400);
    const moved = structuredClone(one.content); moved.version = 2;
    moved.checkpoints[1].customExercises = moved.checkpoints[0].customExercises; delete moved.checkpoints[0].customExercises;
    await post(`${root}/${one.key}/versions`, { content: moved }).expect(400);
    await post(`${root}/${one.key}/versions`, { content: { ...one.content, version: 2 } }).expect(201);
    await post(`${root}/${one.key}/versions`, { content: { ...one.content, version: 3 } }).expect(400);
    expect((await get(`${root}/${two.key}`).expect(200)).body.version).toBe(1);
  });
  it('enforces ownership and immutable custom snapshots even for unclassified versions at the database boundary', async () => {
    const { key, content } = await create();
    await expect(db.query('UPDATE hunt_templates SET key=$2 WHERE key=$1', [key, `renamed-${randomUUID()}`]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(db.query(`UPDATE hunt_template_versions v SET content=content-'checkpoints'
      FROM hunt_templates t WHERE t.id=v.template_id AND t.key=$1`, [key])).rejects.toMatchObject({ code: '23514' });
    const foreign = structuredClone(content); foreign.version = 2;
    await expect(db.query(`INSERT INTO hunt_template_versions(template_id,version,content,origin,created_by_user_id)
      SELECT id,2,$2,'creator',created_by_user_id FROM hunt_templates WHERE key=$1`, [key, foreign])).rejects.toMatchObject({ code: '23514' });
    await post(`${root}/${key}/submit`, { version: 1 }).expect(200);
    await post(`/api/admin/templates/review/${key}/approve`, {}, reviewer).expect(200);
    await post(`${root}/${key}/versions`, { content: { ...content, version: 2 } }).expect(409); // Established legacy lifecycle.
  });
  it('preserves Legacy and both Signal starters exactly through opening and saving', async () => {
    for (const [starter, build] of [['signal-cluj-napoca', createSignalClujNapocaStarter], ['signal-overload-cluj-napoca', createSignalOverloadClujNapocaStarter]] as const) {
      const key = `starter-${randomUUID()}`;
      const saved = (await post(`${root}/starters/${starter}`, { key }).expect(201)).body.content;
      expect(saved).toEqual(build(key)); expect((await get(`${root}/${key}`).expect(200)).body.content).toEqual(saved);
      const next = { ...saved, version: 2 };
      expect((await post(`${root}/${key}/versions`, { content: next }).expect(201)).body.content).toEqual(next);
    }
    const key = `legacy-${randomUUID()}`, content = customTemplateFixture(key); delete content.checkpoints[0].customExercises;
    content.checkpoints[0].unknownLegacy = { answers: ['kept'], hint: 'same' };
    expect((await post(root, { key, content }).expect(201)).body.content).toEqual(content);
    expect((await post(`${root}/${key}/versions`, { content: { ...content, version: 2 } }).expect(201)).body.content).toEqual({ ...content, version: 2 });
  });
  it('captures a Local Hunt snapshot exactly, blocks publish and protects public/participant/supervisor reads', async () => {
    const key = `local-${randomUUID()}`, content = customTemplateFixture(key, 1, [exerciseFixtures[1], exerciseFixtures[21]]);
    content.configuration.checkpointPositions = [{ checkpointNumber: 1, name: 'Start', latitude: 46, longitude: 23, radiusMeters: 10 }];
    content.configuration.finishPoint = { name: 'Finish', latitude: 46.1, longitude: 23.1, radiusMeters: 10 };
    const saved = (await post(root, { key, content, category: 'local', localityId }).expect(201)).body.content;
    await post(`${root}/${key}/submit`, { version: 1 }).expect(200);
    await post(`/api/admin/templates/review/${key}/approve`, { version: 1 }, reviewer).expect(200);
    const template = await model.HuntTemplates.findByKey(key);
    const hunt = (await post('/api/hunts', { organizationId, name: 'Custom Hunt' }).expect(201)).body;
    const selected = await request(app).put(`/api/hunts/${hunt.id}/local-template`).set('Authorization', owner.auth)
      .send({ templateId: template!.id, version: 1, countryCode: 'RO', localityId }).expect(200);
    expect(selected.body.templateSnapshot).toEqual(saved);
    const revision = structuredClone(saved); revision.version = 2; instance(revision).title = 'Local revision';
    const revised = await post(`${root}/${key}/versions`, { content: revision }).expect(201);
    expect(instance(revised.body.content).owner).toEqual({ templateKey: key, version: 2 });
    expect(instance(revised.body.content).id).not.toBe(instance(saved).id);
    expect(await artifact(key, 1)).toEqual(saved);
    expect((await get(`${root}/${key}`).expect(200)).body.localApprovedVersion).toBe(1);
    const preview = await get(`/api/organizer/local-templates/${template!.id}/versions/1?countryCode=RO&localityId=${localityId}`).expect(200);
    expect(JSON.stringify(preview.body)).not.toContain('customExercises');
    await db.query("UPDATE hunts SET access_code='7KPM4XQ2' WHERE id=$1", [hunt.id]);
    await db.query("INSERT INTO hunt_roles(hunt_id,user_id,role) VALUES ($1,$2,'supervisor')", [hunt.id, supervisor.id]);
    await db.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES ($1,$2)', [hunt.id, participant.id]);
    await db.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES ($1,$2)', [hunt.id, supervisor.id]);
    expect((await get(`/api/hunts/${hunt.id}`).expect(200)).body.templateSnapshot).toEqual(saved);
    expect((await get(`/api/hunts/${hunt.id}`, supervisor).expect(200)).body.templateSnapshot).toBeNull();
    expect((await get('/api/hunts', supervisor).expect(200)).body[0].templateSnapshot).toBeNull();
    await get(`/api/hunts/${hunt.id}`, participant).expect(403);
    const publicRead = await request(app).get('/api/hunt-access/7KPM4XQ2').expect(200);
    expect(Object.keys(publicRead.body).sort()).toEqual(['code', 'huntId', 'name', 'status']);
    const contexts = await get('/api/me/hunt-contexts', participant).expect(200);
    expect(JSON.stringify(contexts.body)).not.toContain('customExercises');
    const publish = await post(`/api/hunts/${hunt.id}/publish`, {}).expect(422);
    expect(publish.body.issues.some((issue: any) => issue.message.includes('Custom exercise gameplay'))).toBe(true);
    expect((await db.query('SELECT template_snapshot FROM hunts WHERE id=$1', [hunt.id])).rows[0].template_snapshot).toEqual(saved);
  });
});
