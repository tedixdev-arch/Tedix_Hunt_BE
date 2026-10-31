import { customTemplateFixture, exerciseFixtures } from '../test/customExercises.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { signalClujNapocaV1 } from '../domain/templates/signalClujNapocaV1.js';

const testUrl = process.env.TEST_DATABASE_URL;
const name = `radius_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;
suite('Task 5B real authenticated Express/PostgreSQL radius configuration', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool, appPool: Pool, app: ReturnType<typeof import('../app.js').createApp>;
  let sign: typeof import('../lib/jwt.js').signJwt;
  const users: Record<string, string> = {};
  let org: string, locality: string;
  const auth = (who = 'creator') => `Bearer ${sign({ sub: users[who], type: 'access' })}`;
  const post = (path: string, body: object, who = 'creator') => request(app).post(path).set('Authorization', auth(who)).send(body);
  const patch = (path: string, body: object, who = 'organizer') => request(app).patch(path).set('Authorization', auth(who)).send(body);
  const content = (key: string, version = 1, radius?: number) => ({ key, version, displayName: 'Radius route', theme: 'Explore', mission: { name: 'Find' }, scoring: { startingScore: 100 },
    configuration: { normalCheckpointCount: 2, checkpointPositions: [1, 2].map(checkpointNumber => ({ checkpointNumber, name: 'Overlapping square', latitude: 46, longitude: 23, ...(radius === undefined ? {} : { radiusMeters: radius }) })),
      finishPoint: { name: 'Finish', latitude: 46, longitude: 23, ...(radius === undefined ? {} : { radiusMeters: radius }) } },
    checkpoints: [{ checkpoint: 1 }, { checkpoint: 2 }, { role: 'terminal', navigationMode: 'none' }] });
  const create = async (radius?: number) => {
    const key = `radius-${randomUUID()}`;
    const response = await post('/api/creator/templates', { key, content: content(key, 1, radius), category: 'local', localityId: locality }).expect(201);
    const id = (await db.query('SELECT id FROM hunt_templates WHERE key=$1', [key])).rows[0].id;
    return { key, id, content: response.body.content };
  };
  const approve = async (key: string, version = 1) => {
    await post(`/api/creator/templates/${key}/submit`, { version }).expect(200);
    await post(`/api/admin/templates/review/${key}/approve`, { version }, 'admin').expect(200);
  };
  const hunt = async (a: { key: string; id: string }, version = 1) => {
    const h = (await post('/api/hunts', { organizationId: org, name: 'Radius Hunt' }, 'organizer').expect(201)).body.id;
    await request(app).put(`/api/hunts/${h}/local-template`).set('Authorization', auth('organizer'))
      .send({ templateId: a.id, version, countryCode: 'RO', localityId: locality }).expect(200);
    return h as string;
  };
  const state = async (h: string) => (await db.query('SELECT * FROM hunts WHERE id=$1', [h])).rows[0];
  const override = (h: string, key: string, radii: object, who = 'organizer', version = 1) => patch(`/api/hunts/${h}/checkpoint-radii`, { templateKey: key, templateVersion: version, radii }, who);
  const point = (n: number, r: unknown) => ({ checkpointPositions: [{ checkpointNumber: n, radiusMeters: r }] });
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(testUrl!); url.pathname = `/${name}`; db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const dir = new URL('../db/migrations/', import.meta.url); const migrations = [];
      for (const f of (await readdir(dir)).filter(f => /^\d{3}_.*\.ts$/.test(f)).sort()) migrations.push((await import(new URL(f, dir).href)).default);
      await runMigrations(client, migrations);
    } finally { client.release(); }
    for (const who of ['creator','organizer','admin','other','supervisor','participant','blocked']) {
      users[who] = (await db.query("INSERT INTO users(email,role,account_status) VALUES($1,'participant',$2) RETURNING id", [`${who}@radius.invalid`, who === 'blocked' ? 'blocked' : 'active'])).rows[0].id;
      await db.query('INSERT INTO user_roles VALUES($1,$2)', [users[who], ['creator','organizer','admin'].includes(who) ? who : who === 'other' ? 'creator' : 'participant']);
    }
    org = (await db.query("INSERT INTO organizations(name,owner_id) VALUES('Radius test',$1) RETURNING id", [users.organizer])).rows[0].id;
    locality = (await db.query("INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provenance) VALUES('RO','Square','County',46,23,'test') RETURNING id")).rows[0].id;
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    appPool = (await import('../lib/postgres.js')).pool; app = (await import('../app.js')).createApp(); sign = (await import('../lib/jwt.js')).signJwt;
  }, 30000);
  afterAll(async () => { app?.locals.stopAbuseProtection(); await appPool?.end(); await db?.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end(); });

  it('defaults each new checkpoint and FinishPoint to 25 m at persistence', async () => {
    const a = await create();
    const saved = (await db.query('SELECT content FROM hunt_template_versions WHERE template_id=$1', [a.id])).rows[0].content;
    expect(saved.configuration.checkpointPositions.map((p: any) => p.radiusMeters)).toEqual([25,25]);
    expect(saved.configuration.finishPoint.radiusMeters).toBe(25);
  });
  it('preserves explicit Creator and FinishPoint radii outside proposed 10–100 m', async () => {
    const a = await create(5); await approve(a.key);
    const revised = content(a.key, 2, 500);
    await post(`/api/creator/templates/${a.key}/versions`, { content: revised }).expect(201);
    const rows = (await db.query('SELECT content FROM hunt_template_versions WHERE template_id=$1 ORDER BY version', [a.id])).rows;
    expect(rows[0].content.configuration.finishPoint.radiusMeters).toBe(5);
    expect(rows[1].content.configuration.checkpointPositions[0].radiusMeters).toBe(500);
  });
  it('inherits omitted radii from the prior immutable revision without resetting them', async () => {
    const a = await create(37);
    await post(`/api/creator/templates/${a.key}/versions`, { content: content(a.key, 2) }).expect(201);
    const saved = (await db.query('SELECT content FROM hunt_template_versions WHERE template_id=$1 AND version=2', [a.id])).rows[0].content;
    expect(saved.configuration.checkpointPositions[0].radiusMeters).toBe(37); expect(saved.configuration.finishPoint.radiusMeters).toBe(37);
  });
  it('inherits selected version and overrides only the Hunt execution configuration', async () => {
    const a = await create(37); await approve(a.key); const h = await hunt(a); const before = await state(h);
    expect(before.checkpoint_radius_configuration.checkpointPositions[0].radiusMeters).toBe(37);
    const r = await override(h, a.key, { ...point(1, 63), finishPoint: { radiusMeters: 74 } }).expect(200);
    expect(r.body.checkpointRadiusConfiguration).toEqual({ checkpointPositions: [{ checkpointNumber: 1, radiusMeters: 63 }, { checkpointNumber: 2, radiusMeters: 37 }], finishPoint: { radiusMeters: 74 } });
    expect((await state(h)).template_snapshot).toEqual(before.template_snapshot);
    expect((await db.query('SELECT content FROM hunt_template_versions WHERE template_id=$1', [a.id])).rows[0].content).toEqual(before.template_snapshot);
    await expect(db.query("UPDATE hunts SET template_snapshot=jsonb_set(template_snapshot,'{configuration,finishPoint,radiusMeters}','99') WHERE id=$1", [h])).rejects.toMatchObject({ code: '23514' });
  });
  it('allows overlapping circles without completing or unlocking any checkpoint', async () => {
    const a = await create(25); await approve(a.key); const h = await hunt(a);
    await override(h, a.key, point(1, 500)).expect(200);
    await db.query("UPDATE hunts SET status='active' WHERE id=$1", [h]);
    await db.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES($1,$2)', [h, users.participant]);
    const r = await request(app).get(`/api/hunts/${h}/participants/me`).set('Authorization', auth('participant')).expect(200);
    expect(r.body.checkpoints.map((p: any) => p.accessState)).toEqual(['eligible_for_proximity','not_yet_accessible','not_yet_accessible']);
    expect(r.body.checkpoints.every((p: any) => !p.mayAccessGameplay && !p.gameplayCompleted)).toBe(true);
    const gps = { latitude: 46, longitude: 23, accuracyMeters: 1, observedAt: new Date().toISOString() };
    await request(app).post(`/api/hunts/${h}/checkpoints/${r.body.checkpoints[0].checkpointId}/proximity`).set('Authorization', auth('participant')).send(gps).expect(422, { error: 'proximity_policy_unresolved' });
    await request(app).post(`/api/hunts/${h}/checkpoints/${r.body.checkpoints[1].checkpointId}/proximity`).set('Authorization', auth('participant')).send(gps).expect(409);
  });
  it('allows Admin radius-only Local draft revisions while retaining original ownership', async () => {
    const a = await create(25);
    await patch(`/api/admin/templates/review/${a.key}/checkpoint-radii`, { version: 1, radii: { ...point(2, 81), finishPoint: { radiusMeters: 91 } } }, 'admin').expect(200);
    const rows = (await db.query('SELECT * FROM hunt_template_versions WHERE template_id=$1 ORDER BY version', [a.id])).rows;
    expect(rows).toHaveLength(2); expect(rows.every(r => r.created_by_user_id === users.creator)).toBe(true);
    expect(rows[0].content.configuration.finishPoint.radiusMeters).toBe(25); expect(rows[1].content.configuration.finishPoint.radiusMeters).toBe(91);
    await approve(a.key, 2);
    await patch(`/api/admin/templates/review/${a.key}/checkpoint-radii`, { version: 2, radii: point(1, 33) }, 'admin').expect(409);
  });
  it('rejects anonymous, other Creator, Participant, Supervisor, global Admin and blocked Hunt edits', async () => {
    const a = await create(); await approve(a.key); const h = await hunt(a);
    await db.query("INSERT INTO hunt_roles VALUES($1,$2,'supervisor')", [h, users.supervisor]);
    await request(app).patch(`/api/hunts/${h}/checkpoint-radii`).send({}).expect(401);
    for (const who of ['creator','other','participant','supervisor','admin']) await override(h, a.key, point(1, 36), who).expect(403);
    await override(h, a.key, point(1, 36), 'blocked').expect(401);
    await patch(`/api/admin/templates/review/${a.key}/checkpoint-radii`, { version: 1, radii: point(1, 36) }, 'creator').expect(403);
    await post(`/api/creator/templates/${a.key}/versions`, { content: content(a.key, 2, 40) }, 'other').expect(404);
  });
  it.each(['published','active','paused','finished','cancelled'])('freezes execution radii for %s Hunts in API and database', async status => {
    const a = await create(); await approve(a.key); const h = await hunt(a); const before = await state(h);
    await db.query('UPDATE hunts SET status=$2 WHERE id=$1', [h,status]);
    await override(h, a.key, point(1, 50)).expect(409);
    await expect(db.query("UPDATE hunts SET checkpoint_radius_configuration='{}' WHERE id=$1", [h])).rejects.toMatchObject({ code: '23514' });
    expect((await state(h)).checkpoint_radius_configuration).toEqual(before.checkpoint_radius_configuration);
  });
  it('rejects invalid numeric values and unknown or duplicate checkpoint identities atomically', async () => {
    const a = await create(); await approve(a.key); const h = await hunt(a); const before = await state(h);
    for (const r of [null,'25',true,0,-1,4,501,1e100]) {
      await override(h, a.key, point(1,r)).expect(400);
      const c = content(`bad-${randomUUID()}`); (c.configuration.checkpointPositions[0] as any).radiusMeters = r;
      await post('/api/creator/templates', { key: c.key, content: c }).expect(400);
    }
    await override(h, a.key, { checkpointPositions: [{checkpointNumber:1,radiusMeters:25},{checkpointNumber:1,radiusMeters:30}] }).expect(400);
    await override(h, a.key, point(3,30)).expect(422);
    await override(h, a.key, { finishPoint: { radiusMeters: 25.5 } }).expect(400);
    await override(h, a.key, { radiusMeters: 30 }).expect(400);
    expect(await state(h)).toEqual(before);
  });
  it('serializes disjoint concurrent setup without losing either override', async () => {
    const a = await create(); await approve(a.key); const h = await hunt(a);
    await Promise.all([override(h,a.key,point(1,31)).expect(200), override(h,a.key,point(2,42)).expect(200)]);
    expect((await state(h)).checkpoint_radius_configuration.checkpointPositions.map((p: any) => p.radiusMeters)).toEqual([31,42]);
  });
  it('rechecks draft state after waiting on a concurrent publication lock', async () => {
    const a = await create(); await approve(a.key); const h = await hunt(a); const before = await state(h);
    const blocker = await db.connect();
    let pending: Promise<any> | undefined;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM hunts WHERE id=$1 FOR UPDATE', [h]);
      pending = override(h,a.key,point(1,67)).then(r => r);
      await expect.poll(async () => Number((await db.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0")).rows[0].count)).toBeGreaterThan(0);
      await blocker.query("UPDATE hunts SET status='published' WHERE id=$1", [h]); await blocker.query('COMMIT');
      expect((await pending).status).toBe(409);
      expect((await state(h)).checkpoint_radius_configuration).toEqual(before.checkpoint_radius_configuration);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
  });
  it('serializes concurrent Admin revisions against the exact latest version', async () => {
    const a = await create();
    const path = `/api/admin/templates/review/${a.key}/checkpoint-radii`;
    const results = await Promise.all([patch(path,{version:1,radii:point(1,31)},'admin'),patch(path,{version:1,radii:point(2,41)},'admin')]);
    expect(results.map(r => r.status).sort()).toEqual([200,409]);
    expect((await db.query('SELECT version FROM hunt_template_versions WHERE template_id=$1 ORDER BY version',[a.id])).rows).toEqual([{version:1},{version:2}]);
    await post(`/api/creator/templates/${a.key}/submit`,{version:2}).expect(200);
    await patch(path,{version:2,radii:point(1,40)},'admin').expect(409);
  });
  it('pins older Hunt configuration through later Template revisions and rejects stale setup references', async () => {
    const a = await create(17); await approve(a.key); const h = await hunt(a); await override(h,a.key,point(1,29)).expect(200);
    const before = await state(h);
    await post(`/api/creator/templates/${a.key}/versions`, { content: content(a.key,2,49) }).expect(201); await approve(a.key,2);
    const next = await hunt(a,2);
    expect((await state(next)).checkpoint_radius_configuration.checkpointPositions[0].radiusMeters).toBe(49);
    expect(await state(h)).toEqual(before);
    await override(next,a.key,point(1,70)).expect(409);
  });
  it('preserves canonical Signal history with null execution radii and no invented geography', async () => {
    const h = (await db.query("INSERT INTO hunts(organization_id,created_by_user_id,name,status,template_key,template_version,template_snapshot) VALUES($1,$2,'History','published',$3,1,$4) RETURNING id", [org,users.organizer,signalClujNapocaV1.key,signalClujNapocaV1])).rows[0].id;
    expect((await state(h)).checkpoint_radius_configuration).toBeNull(); expect((await state(h)).template_snapshot).toEqual(signalClujNapocaV1);
  });
  it('retains the custom gameplay publication guard after radius customization', async () => {
    const key = `radius-custom-${randomUUID()}`;
    const c = customTemplateFixture(key, 1, exerciseFixtures.slice(0, 1));
    c.configuration.checkpointPositions = [{ checkpointNumber: 1, name: 'Start', latitude: 46, longitude: 23, radiusMeters: 25 }];
    c.configuration.finishPoint = { name: 'Finish', latitude: 46, longitude: 23, radiusMeters: 25 };
    await post('/api/creator/templates', { key, content: c, category: 'local', localityId: locality }).expect(201);
    const id = (await db.query('SELECT id FROM hunt_templates WHERE key=$1', [key])).rows[0].id;
    await approve(key); const h = await hunt({ key, id });
    await override(h,key,point(1,30)).expect(200);
    await patch(`/api/hunts/${h}`, { country: 'Romania', region: 'County', city: 'Square', startDate: '2027-01-01', startTime: '10:00', timezone: 'Europe/Bucharest', durationMinutes: 60, capacity: 12, contactName: 'Contact', format: 'team', teamSize: 4, accessMode: 'invitation_only', difficulty: 'easy', checkpointOrder: 'recommended' }).expect(200);
    const r = await post(`/api/hunts/${h}/publish`, {}, 'organizer').expect(422);
    expect(r.body.issues.some((issue: any) => issue.message.includes('custom') || issue.message.includes('Custom'))).toBe(true);
    expect((await state(h)).status).toBe('draft');
  });
});
