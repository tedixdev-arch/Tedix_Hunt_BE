import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrate.js';
import bindingMigration from './migrations/026_template_locality_binding.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const databaseName = `c6b4_${randomUUID().replaceAll('-', '')}`;
const root = '/api/creator/templates';
const content = (key: string, version = 1) => ({ key, version, displayName: 'Binding fixture', theme: 'Explore', mission: { name: 'Find' }, scoring: { startingScore: 100 },
  configuration: { normalCheckpointCount: 1,
    checkpointPositions: [{ checkpointNumber: 1, name: 'Square', latitude: 46, longitude: 23, radiusMeters: 30 }],
    finishPoint: { name: 'Finish', latitude: 46, longitude: 23, radiusMeters: 10 } },
  checkpoints: [{ checkpoint: 1, kind: 'hidden-rule' }, { role: 'terminal', navigationMode: 'none' }],
});

suite('C6b-4 version locality binding against disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let appPool: Pool;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let model: typeof import('../models/HuntTemplate.js').HuntTemplates;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  const actors: Record<string, string> = {};
  const migrations: Migration[] = [];
  let place: string;
  let otherPlace: string;
  let inactive: string;
  const auth = (role = 'creator') => `Bearer ${signJwt({ sub: actors[role], type: 'access', roles: ['creator', 'admin'] })}`;
  const post = (path: string, body: object, role = 'creator') => request(app).post(path).set('Authorization', auth(role)).send(body);
  const create = async (selection: object = {}, category: string | null = 'local') => {
    const key = `binding-${randomUUID()}`;
    const response = await post(root, { key, content: content(key), ...(category ? { category } : {}), ...selection }).expect(201);
    return { key, response };
  };
  const save = (key: string, version: number, selection: object = {}, role = 'creator') =>
    post(`${root}/${key}/versions`, { content: content(key, version), ...selection }, role);
  const stored = async (key: string) => (await db.query(`SELECT v.* FROM hunt_template_versions v JOIN hunt_templates t ON t.id=v.template_id WHERE t.key=$1 ORDER BY v.version`, [key])).rows;
  const state = async (key: string) => ({ identity: (await db.query('SELECT * FROM hunt_templates WHERE key=$1', [key])).rows, versions: await stored(key) });
  const locality = async (active = true) => (await db.query(`INSERT INTO localities
    (country_code,name,administrative_context,latitude,longitude,active,provenance)
    VALUES ('RO','Same name','County',46.77,23.62,$1,'Private Admin decision evidence') RETURNING id`, [active])).rows[0].id;
  const pair = (row: any) => ({ localityId: row.locality_id, localitySnapshot: row.locality_snapshot });
  const history = async () => ({
    templates: (await db.query('SELECT * FROM hunt_templates ORDER BY id')).rows,
    versions: (await db.query('SELECT id,template_id,version,content,origin,category,created_by_user_id,created_at FROM hunt_template_versions ORDER BY id')).rows,
    reviews: (await db.query('SELECT * FROM hunt_template_reviews ORDER BY template_id,version')).rows,
    hunts: (await db.query('SELECT * FROM hunts ORDER BY id')).rows,
  });
  // Check a real server lock wait, without timing-based race assumptions.
  const blockedBy = async (client: PoolClient) => {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await expect.poll(async () => Number((await db.query('SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].count), { timeout: 5000 }).toBeGreaterThan(0);
  };
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('./pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('./migrations/', import.meta.url);
      for (const file of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name) && name < '026').sort()) migrations.push((await import(new URL(file, directory).href)).default);
      await runMigrations(client, migrations);
      for (const role of ['creator','other','admin','organizer','guest','blocked','retired','revoked']) {
        const persisted = ['other','guest','blocked','retired','revoked'].includes(role) ? 'creator' : role;
        actors[role] = (await db.query(`INSERT INTO users (email,role,is_guest,account_status) VALUES ($1,$2,$3,$4) RETURNING id`,
          [`${role}@binding.invalid`, persisted, role === 'guest', ['blocked','retired'].includes(role) ? role : 'active'])).rows[0].id;
        await db.query('INSERT INTO user_roles VALUES ($1,$2)', [actors[role], persisted]);
      }
      await db.query('DELETE FROM user_roles WHERE user_id=$1', [actors.revoked]);
      for (const status of ['draft','submitted','approved']) {
        const key = `historical-${status}`;
        const id = (await db.query(`INSERT INTO hunt_templates (key,origin,category,created_by_user_id,status) VALUES ($1,'creator','local',$2,'draft') RETURNING id`, [key, actors.creator])).rows[0].id;
        await db.query(`INSERT INTO hunt_template_versions (template_id,version,content,origin,category,created_by_user_id) VALUES ($1,1,$2,'creator','local',$3)`, [id,content(key),actors.creator]);
        if (status !== 'draft') await db.query('UPDATE hunt_templates SET status=$2,submitted_version=1 WHERE id=$1', [id,status]);
        if (status === 'approved') await db.query("INSERT INTO hunt_template_reviews (template_id,version,reviewer_user_id,decision) VALUES ($1,1,$2,'approved')", [id,actors.admin]);
      }
      const org = (await db.query("INSERT INTO organizations (name,owner_id) VALUES ('History',$1) RETURNING id", [actors.creator])).rows[0].id;
      await db.query(`INSERT INTO hunts (organization_id,created_by_user_id,name,status,country,region,city,template_key,template_version,template_snapshot)
        VALUES ($1,$2,'Frozen','finished','Romania','Cluj','Cluj-Napoca','signal-cluj-napoca',1,'{"frozen":"unchanged"}')`, [org,actors.creator]);
      const before = await history();
      migrations.push(bindingMigration);
      expect(await runMigrations(client, migrations)).toEqual(['026_template_locality_binding']);
      expect(await runMigrations(client, migrations)).toEqual([]);
      expect(await history()).toEqual(before);
      expect((await db.query('SELECT DISTINCT locality_id,locality_snapshot FROM hunt_template_versions')).rows).toEqual([{ locality_id: null, locality_snapshot: null }]);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    appPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); model = (await import('../models/HuntTemplate.js')).HuntTemplates;
    signJwt = (await import('../lib/jwt.js')).signJwt;
    place = await locality(); otherPlace = await locality(); inactive = await locality(false);
  }, 30_000);
  afterAll(async () => {
    await appPool?.end(); await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await admin.end();
  });

  it('matches fresh-schema columns, constraints and history-protection functions', async () => {
    const client = await db.connect();
    const inspect = async () => ({
      columns: (await client.query(`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='hunt_template_versions' ORDER BY ordinal_position`)).rows,
      constraints: (await client.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='hunt_template_versions'::regclass ORDER BY conname`)).rows,
      trigger: (await client.query(`SELECT pg_get_functiondef('enforce_template_version_binding()'::regprocedure) AS definition`)).rows,
    });
    try {
      const upgraded = await inspect();
      await client.query('BEGIN; CREATE SCHEMA fresh_binding; SET LOCAL search_path TO fresh_binding,public');
      await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
      const fresh = await inspect();
      // Function definitions carry their namespace; behavior/body must match.
      fresh.trigger[0].definition = fresh.trigger[0].definition.replace('fresh_binding.', 'public.').replace(/\s+/g, ' ').trim();
      upgraded.trigger[0].definition = upgraded.trigger[0].definition.replace(/\s+/g, ' ').trim();
      expect(fresh).toEqual(upgraded);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('supports unbound scratch creates and exact inheritance, refresh, change and clear', async () => {
    for (const selection of [{}, { localityId: null }]) {
      const { key, response } = await create(selection);
      expect(response.body).toMatchObject({ localityId: null, localitySnapshot: null });
      expect((await save(key, 2).expect(201)).body).toMatchObject({ localityId: null, localitySnapshot: null });
    }
    const incompleteKey = `incomplete-${randomUUID()}`;
    await post(root, { key: incompleteKey, category: 'local', content: { ...content(incompleteKey), configuration: { durationMinutes: 45 }, checkpoints: [{ kind: 'hidden-rule' }] } }).expect(201);
    expect(pair((await stored(incompleteKey))[0])).toEqual({ localityId: null, localitySnapshot: null });
    const { key, response } = await create({ localityId: place });
    const original = response.body.localitySnapshot;
    expect(Object.keys(original).sort()).toEqual(['id','countryCode','countryDisplayName','name','administrativeContext','latitude','longitude'].sort());
    await db.query("UPDATE localities SET name='Corrected',latitude=47 WHERE id=$1", [place]);
    await db.query("UPDATE countries SET display_name='Corrected Romania' WHERE code='RO'");
    expect((await save(key, 2).expect(201)).body.localitySnapshot).toEqual(original);
    const refreshed = (await save(key, 3, { localityId: place }).expect(201)).body;
    expect(refreshed.localitySnapshot).toMatchObject({ name: 'Corrected', latitude: 47, countryDisplayName: 'Corrected Romania' });
    expect((await save(key, 4, { localityId: otherPlace }).expect(201)).body.localityId).toBe(otherPlace);
    expect((await save(key, 5, { localityId: null }).expect(201)).body).toMatchObject({ localityId: null, localitySnapshot: null });
    expect((await stored(key))[0].locality_snapshot).toEqual(original);
    expect((await stored(key)).map(v => v.version)).toEqual([1,2,3,4,5]);
    await db.query("UPDATE countries SET display_name='Romania' WHERE code='RO'");
  });

  it('inherits inactive facts without catalog refresh, but rejects explicit inactive selection', async () => {
    const id = await locality(); const { key, response } = await create({ localityId: id });
    await db.query('UPDATE localities SET active=FALSE WHERE id=$1', [id]);
    expect((await save(key, 2).expect(201)).body.localitySnapshot).toEqual(response.body.localitySnapshot);
    const before = await state(key);
    await save(key, 3, { localityId: id }).expect(409, { error: 'locality_unavailable' });
    expect(await state(key)).toEqual(before);
  });

  it('rejects malformed, absent, inactive and forbidden metadata without writes', async () => {
    const { key } = await create();
    for (const [selection,status,error] of [
      [{ localityId: 'bad' },400,'invalid_input'], [{ localityId: 42 },400,'invalid_input'],
      [{ localityId: {} },400,'invalid_input'], [{ localityId: [] },400,'invalid_input'],
      [{ localityId: randomUUID() },404,'locality_not_found'], [{ localityId: inactive },409,'locality_unavailable'],
      [{ localitySnapshot: {} },400,'invalid_input'], [{ countryCode: 'RO' },400,'invalid_input'],
    ] as const) {
      const before = await state(key);
      await save(key, 2, selection).expect(status, { error });
      expect(await state(key)).toEqual(before);
      const newKey = `invalid-${randomUUID()}`;
      await post(root, { key: newKey, category: 'local', content: content(newKey), ...selection }).expect(status, { error });
      expect((await state(newKey)).identity).toEqual([]);
    }
    for (const field of ['localityId','localitySnapshot']) {
      await post(`${root}/${key}/versions`, { content: { ...content(key,2), [field]: place } }).expect(400);
    }
  });

  it('does not bind proposal IDs or associate on approval; binds the explicitly returned catalog ID', async () => {
    const { key } = await create();
    const proposal = (await post('/api/geography/locality-proposals', { countryCode: 'RO', name: `Manual ${randomUUID()}`,
      administrativeContext: 'County', latitude: 46, longitude: 23,
      explanation: 'Missing settlement confirmed independently in the national gazetteer.',
      evidenceReference: 'National gazetteer, 2026 edition, County entry coordinate table page 42.' }).expect(201)).body;
    await save(key, 2, { localityId: proposal.id }).expect(404, { error: 'locality_not_found' });
    const before = await state(key);
    const approved = (await post(`/api/admin/locality-proposals/${proposal.id}/decision`, { decision: 'approved', reason: 'Confirmed against independent national gazetteer.' }, 'admin').expect(200)).body;
    expect(await state(key)).toEqual(before);
    await save(key, 2, { localityId: proposal.id }).expect(404);
    const bound = (await save(key, 2, { localityId: approved.localityId }).expect(201)).body;
    expect(bound.localitySnapshot).toEqual({ id: approved.localityId, countryCode: 'RO', countryDisplayName: 'Romania', name: proposal.name, administrativeContext: 'County', latitude: 46, longitude: 23 });
    expect(JSON.stringify(bound.localitySnapshot)).not.toMatch(/reason|evidence|reviewer|provider|provenance|active/i);
    const rejected = (await post('/api/geography/locality-proposals', { countryCode: 'RO', name: `Rejected ${randomUUID()}`, administrativeContext: 'County', latitude: 46, longitude: 23, explanation: 'Missing settlement requiring independent gazetteer verification.', evidenceReference: 'National gazetteer, 2026 edition, County coordinate table page 43.' }).expect(201)).body;
    await post(`/api/admin/locality-proposals/${rejected.id}/decision`, { decision: 'rejected', reason: 'Independent gazetteer does not establish this settlement.' }, 'admin').expect(200);
    await save(key, 3, { localityId: rejected.id }).expect(404, { error: 'locality_not_found' });
  });

  it('returns saved pairs in Creator save/list/detail/submit and pinned Admin review responses', async () => {
    const { key, response } = await create({ localityId: otherPlace });
    const expected = { localityId: otherPlace, localitySnapshot: response.body.localitySnapshot };
    await db.query("UPDATE localities SET name='Later catalog fact' WHERE id=$1", [otherPlace]);
    const detail = await request(app).get(`${root}/${key}`).set('Authorization', auth()).expect(200);
    expect(detail.body).toMatchObject({ version: 1, content: content(key), ...expected });
    const list = await request(app).get(root).set('Authorization', auth()).expect(200);
    expect(list.body.find((t: any) => t.key === key)).toEqual(detail.body);
    expect((await post(`${root}/${key}/submit`, { version: 1 }).expect(200)).body).toMatchObject(expected);
    expect(await model.findSubmittedCreatorReviewByKey(key)).toMatchObject(expected);
    expect((await request(app).get(`/api/admin/templates/review/${key}`).set('Authorization',auth('admin')).expect(200)).body).toMatchObject(expected);
    const queue = await request(app).get('/api/admin/templates/review').set('Authorization',auth('admin')).expect(200);
    expect(queue.body.templates.find((t: any) => t.key===key)).toMatchObject(expected);
    expect((await model.listSubmittedCreatorReviews()).find(t => t.key === key)).toMatchObject(expected);
    const changed = await model.requestChangesForSubmittedCreator(key, actors.admin, 1);
    expect(changed).toMatchObject(expected);
    await save(key, 2, { localityId: null }).expect(201);
    const identity = await model.findByKey(key);
    expect(await model.getVersion(identity!.id, 1)).toMatchObject(expected);
    expect(await model.getLatestVersion(identity!.id)).toMatchObject({ localityId: null, localitySnapshot: null });
    await post(`${root}/${key}/submit`, { version: 2 }).expect(200);
    // A newer stored row must never supply metadata for the pinned review artifact.
    await db.query(`INSERT INTO hunt_template_versions (template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot) VALUES ($1,3,$2,'creator','local',$3,$4,$5)`, [identity!.id,content(key,3),actors.creator,otherPlace,expected.localitySnapshot]);
    expect(await model.findSubmittedCreatorReviewByKey(key)).toMatchObject({ version: 2, localityId: null, localitySnapshot: null });
    expect((await post(`/api/admin/templates/review/${key}/approve`, { version: 2 }, 'admin').expect(200)).body).toMatchObject({ version: 2, localityId: null, localitySnapshot: null });
    expect(await model.getVersion(identity!.id, 1)).toMatchObject(expected);
    // Pre-migration submitted/approved NULLs remain readable and approvable, no new gate.
    expect(await model.findSubmittedCreatorReviewByKey('historical-submitted')).toMatchObject({ localityId: null, localitySnapshot: null });
    expect(await model.approveSubmittedCreator('historical-submitted', actors.admin, 1)).toMatchObject({ localityId: null, localitySnapshot: null });
    await post(`${root}/historical-draft/submit`, { version: 1 }).expect(200);
  });

  it('preserves persisted capability checks, nondisclosure, category and lifecycle restrictions', async () => {
    const { key } = await create();
    for (const [role,status] of [['guest',403],['blocked',401],['retired',401],['revoked',403],['admin',403],['organizer',403]] as const) {
      await save(key, 2, { localityId: place }, role).expect(status);
      const newKey = `denied-${randomUUID()}`;
      await post(root, { key: newKey, category: 'local', content: content(newKey), localityId: place }, role).expect(status);
      expect((await state(newKey)).identity).toEqual([]);
    }
    await request(app).post(`${root}/${key}/versions`).send({ content: content(key,2), localityId: place }).expect(401);
    for (const target of [key, 'missing-template', 'signal-cluj-napoca']) {
      await save(target, 2, { localityId: randomUUID() }, 'other').expect(404, { error: 'not_found' });
    }
    for (const category of ['universal',null]) {
      const draft = await create({},category);
      for (const localityId of [null,place]) {
        await save(draft.key, 2, { localityId }).expect(400, { error: 'invalid_input' });
        const newKey = `forbidden-${randomUUID()}`;
        await post(root, { key: newKey, content: content(newKey), ...(category ? { category } : {}), localityId }).expect(400, { error: 'invalid_input' });
      }
      expect(pair((await stored(draft.key))[0])).toEqual({ localityId: null, localitySnapshot: null });
    }
    const submitted = await create();
    await post(`${root}/${submitted.key}/submit`, { version: 1 }).expect(200);
    for (const target of [submitted.key,'historical-approved']) {
      await save(target,2,{ localityId: randomUUID() }).expect(409, { error: 'template_not_editable' });
    }
  });

  it('enforces SQL pair, shape/type/bounds, FK, category, immutability and deletion protections', async () => {
    const { key, response } = await create({ localityId: place });
    const row = (await stored(key))[0];
    const snapshot = response.body.localitySnapshot;
    const insert = (id: unknown, json: unknown, category: string | null = 'local', templateId = row.template_id) => db.query(`INSERT INTO hunt_template_versions
      (template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot)
      VALUES ($1,2,'{}','creator',$2,$3,$4,$5)`, [templateId,category,actors.creator,id,JSON.stringify(json)]);
    const invalid: [unknown, unknown][] = [[null,snapshot],[place,null],[place,[]],[place,'bad'],[place,42],[place,{ ...snapshot,id: randomUUID() }]];
    for (const field of Object.keys(snapshot)) {
      const missing = { ...snapshot }; delete missing[field]; invalid.push([place,missing]);
      invalid.push([place,{ ...snapshot,[field]: null }], [place,{ ...snapshot,[field]: {} }]);
    }
    for (const patch of [{ name: ' ' },{ name: 'x'.repeat(201) },{ countryCode: 'ro' },{ countryDisplayName: 'x'.repeat(101) },{ administrativeContext: '' },{ latitude: 91 },{ longitude: -181 },{ latitude: '46' },{ longitude: 'Infinity' },{ active: true }]) invalid.push([place,{ ...snapshot,...patch }]);
    for (const [id,json] of invalid) await expect(insert(id,json)).rejects.toMatchObject({ code: '23514' });
    // SQL NULL on either half must fail independently of JSON null.
    await expect(db.query(`INSERT INTO hunt_template_versions (template_id,version,content,origin,category,created_by_user_id,locality_id)
      VALUES ($1,2,'{}','creator','local',$2,$3)`, [row.template_id,actors.creator,place])).rejects.toMatchObject({ code: '23514' });
    const absent = randomUUID(); await expect(insert(absent,{ ...snapshot,id: absent })).rejects.toMatchObject({ code: '23503' });
    for (const category of ['universal',null]) {
      const t = await create({},category); const v = (await stored(t.key))[0];
      await expect(insert(place,snapshot,category,v.template_id)).rejects.toMatchObject({ code: '23514' });
    }
    for (const change of ["content='{}'",'locality_id=NULL,locality_snapshot=NULL',"locality_snapshot='{}'",'category=NULL']) {
      await expect(db.query(`UPDATE hunt_template_versions SET ${change} WHERE id=$1`, [row.id])).rejects.toMatchObject({ code: '23514' });
    }
    await expect(db.query('DELETE FROM localities WHERE id=$1', [place])).rejects.toMatchObject({ code: '23503' });
    await model.deleteCreatorDraft(key,actors.creator);
    expect(await stored(key)).toEqual([]);
    await expect(model.deleteCreatorDraft('historical-approved',actors.creator)).rejects.toThrow();
  });

  it.each(['identity','version','lifecycle','commit'])('rolls back injected failure after %s and reuses the pooled connection', async stage => {
    const key = stage === 'identity' ? `failure-${randomUUID()}` : (await create({ localityId: place })).key;
    if (stage === 'lifecycle') {
      await post(`${root}/${key}/submit`, { version: 1 }).expect(200);
      await model.requestChangesForSubmittedCreator(key,actors.admin,1);
    }
    const before = await state(key);
    const client = await appPool.connect();
    const query = client.query.bind(client);
    const connect = vi.spyOn(appPool,'connect').mockImplementationOnce((async () => client) as any);
    const intercepted = vi.spyOn(client,'query').mockImplementation((async (...args: any[]) => {
      const sql = String(args[0]);
      if (stage === 'commit' && sql === 'COMMIT') throw new Error('injected commit failure');
      const result = await (query as any)(...args);
      if ((stage === 'identity' && sql.includes('INSERT INTO hunt_templates '))
        || (stage === 'version' && sql.includes('INSERT INTO hunt_template_versions'))
        || (stage === 'lifecycle' && sql.includes("SET status = 'draft'"))) throw new Error(`injected ${stage} failure`);
      return result;
    }) as any);
    try {
      if (stage === 'identity') await expect(model.createCreatorDraft(key,content(key),actors.creator,'local',place)).rejects.toThrow('injected');
      else await expect(model.createCreatorVersion(key,content(key,2),actors.creator,otherPlace)).rejects.toThrow('injected');
    } finally { intercepted.mockRestore(); connect.mockRestore(); }
    expect(await state(key)).toEqual(before);
    const reused = await appPool.connect();
    try { expect(reused).toBe(client); expect((await reused.query('SELECT 1 AS ok')).rows).toEqual([{ ok: 1 }]); } finally { reused.release(); }
    if (stage !== 'identity') await save(key,2,{ localityId: otherPlace }).expect(201);
  });

  it('rolls back a real deferred PostgreSQL commit failure', async () => {
    const { key } = await create({ localityId: place }); const before = await state(key);
    await db.query(`CREATE FUNCTION binding_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.content->>'key' = '${key}' AND NEW.version=2 THEN RAISE EXCEPTION 'deferred binding failure'; END IF;
      RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER binding_fail_commit AFTER INSERT ON hunt_template_versions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION binding_fail_commit()`);
    try { await expect(model.createCreatorVersion(key,content(key,2),actors.creator,otherPlace)).rejects.toThrow('deferred binding failure'); }
    finally { await db.query('DROP TRIGGER binding_fail_commit ON hunt_template_versions; DROP FUNCTION binding_fail_commit()'); }
    expect(await state(key)).toEqual(before);
    await save(key,2,{ localityId: otherPlace }).expect(201);
  });

  it('serializes concurrent complete saves and rejects stale content without a duplicate or mixed pair', async () => {
    const { key } = await create(); const lock = await db.connect();
    let pending: Promise<any[]> | undefined;
    try {
      await lock.query('BEGIN'); await lock.query('SELECT id FROM hunt_templates WHERE key=$1 FOR UPDATE', [key]);
      pending = Promise.all([save(key,2,{ localityId: place }).then(r => r),save(key,2,{ localityId: otherPlace }).then(r => r)]);
      await blockedBy(lock); await lock.query('COMMIT');
      const responses = await pending;
      expect(responses.map(r => r.status).sort()).toEqual([201,400]);
      expect(responses.find(r => r.status===400).body).toEqual({ error: 'invalid_input' });
      const winner = responses.find(r => r.status===201).body;
      const versions = await stored(key); expect(versions.map(v => v.version)).toEqual([1,2]);
      expect(pair(versions[1])).toEqual({ localityId: winner.localityId, localitySnapshot: winner.localitySnapshot });
      expect(versions[1].locality_snapshot.id).toBe(versions[1].locality_id);
    } finally { await lock.query('ROLLBACK'); lock.release(); if (pending) await pending; }
  });

  it('serializes save versus submit on the Template identity', async () => {
    const { key } = await create({ localityId: place }); const lock = await db.connect();
    let pending: Promise<any[]> | undefined;
    try {
      await lock.query('BEGIN'); await lock.query('SELECT id FROM hunt_templates WHERE key=$1 FOR UPDATE', [key]);
      pending = Promise.all([save(key,2,{ localityId: otherPlace }).then(r=>r),post(`${root}/${key}/submit`,{ version: 1 }).then(r=>r)]);
      await blockedBy(lock); await lock.query('COMMIT');
      const [saved,submitted] = await pending;
      expect([[201,409],[409,200]]).toContainEqual([saved.status,submitted.status]);
      const versions = await stored(key);
      if (saved.status === 201) { expect(versions).toHaveLength(2); expect(versions[1].locality_id).toBe(otherPlace); }
      else { expect(versions).toHaveLength(1); expect(versions[0].locality_id).toBe(place); }
    } finally { await lock.query('ROLLBACK'); lock.release(); if (pending) await pending; }
  });

  it.each(['correction','deactivation','country rename','membership change'])('locks Country then Locality against %s and reads coherent committed facts', async action => {
    const id = await locality(); const { key } = await create(); const writer = await db.connect();
    let pending: Promise<any> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query("SELECT code FROM countries WHERE code='RO' FOR UPDATE");
      if (action === 'country rename') await writer.query("UPDATE countries SET display_name='Renamed Romania' WHERE code='RO'");
      else if (action === 'correction') await writer.query("UPDATE localities SET name='Atomic corrected',latitude=48,longitude=24 WHERE id=$1",[id]);
      else if (action === 'deactivation') await writer.query('UPDATE localities SET active=FALSE WHERE id=$1',[id]);
      else {
        await writer.query("INSERT INTO countries VALUES ('HU','Hungary') ON CONFLICT DO NOTHING");
        await writer.query("UPDATE localities SET country_code='HU' WHERE id=$1",[id]);
      }
      pending = save(key,2,{ localityId: id }).then(r=>r);
      await blockedBy(writer); await writer.query('COMMIT');
      const response = await pending;
      if (action === 'deactivation' || action === 'membership change') {
        expect(response.status).toBe(409); expect(response.body).toEqual({ error: 'locality_unavailable' }); expect(await stored(key)).toHaveLength(1);
      } else {
        expect(response.status).toBe(201);
        expect(response.body.localitySnapshot).toMatchObject(action === 'correction'
          ? { name: 'Atomic corrected',latitude: 48,longitude: 24,countryDisplayName: 'Romania' }
          : { name: 'Same name',latitude: 46.77,longitude: 23.62,countryDisplayName: 'Renamed Romania' });
      }
    } finally {
      await writer.query('ROLLBACK'); writer.release(); if (pending) await pending;
      await db.query("UPDATE countries SET display_name='Romania' WHERE code='RO'");
    }
  });

  it('holds shared catalog locks through commit so corrections wait for an intact old snapshot', async () => {
    const id = await locality(); const { key } = await create();
    const client = await appPool.connect(); const writer = await db.connect();
    const original = client.query.bind(client);
    let ready!: () => void; const atCommit = new Promise<void>(resolve => { ready=resolve; });
    let proceed!: () => void; const releaseCommit = new Promise<void>(resolve => { proceed=resolve; });
    const connect = vi.spyOn(appPool,'connect').mockImplementationOnce((async () => client) as any);
    const intercepted = vi.spyOn(client,'query').mockImplementation((async (...args: any[]) => {
      if (args[0] === 'COMMIT') { ready(); await releaseCommit; }
      return (original as any)(...args);
    }) as any);
    let saved: Promise<any> | undefined; let writing: Promise<any> | undefined;
    try {
      saved = model.createCreatorVersion(key,content(key,2),actors.creator,id);
      await atCommit;
      await writer.query('BEGIN'); await writer.query("SELECT code FROM countries WHERE code='RO' FOR SHARE");
      writing = writer.query("UPDATE localities SET name='After snapshot',active=FALSE WHERE id=$1",[id]);
      await blockedBy(client); proceed();
      const result = await saved; await writing; await writer.query('COMMIT');
      expect(result.version.localitySnapshot.name).toBe('Same name');
      expect((await stored(key))[1].locality_snapshot.name).toBe('Same name');
    } finally {
      proceed(); if (saved) await saved; if (writing) await writing;
      intercepted.mockRestore(); connect.mockRestore(); await writer.query('ROLLBACK'); writer.release();
    }
  });
});
