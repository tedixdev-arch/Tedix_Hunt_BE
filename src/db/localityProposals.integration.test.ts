import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import proposalMigration from './migrations/025_locality_proposals.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const databaseName = `c6b3_${randomUUID().replaceAll('-', '')}`;
suite('Manual locality proposals against PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let closePool: () => Promise<void>;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  const actors: Record<string, string> = {};
  const migrations: Migration[] = [];
  let historical: unknown;
  const history = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ['hunt_templates','hunt_template_versions','hunt_template_reviews','hunts']) {
      result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;
    }
    return result;
  };
  const bearer = (role: string) => `Bearer ${signJwt({ sub: actors[role], type: 'access', roles: ['admin','creator'] })}`;
  const input = (name = `Place ${randomUUID()}`) => ({ countryCode: 'RO', name, administrativeContext: 'Cluj County',
    latitude: 46.77, longitude: 23.62, explanation: 'Missing settlement with independently verified representative location.',
    evidenceReference: 'National statistical gazetteer, 2026 edition, Cluj County entry and coordinate table, page 42.' });
  const submit = (body: object = input(), actor = 'creator') => request(app).post('/api/geography/locality-proposals')
    .set('Authorization', bearer(actor)).send(body);
  const decide = (id: string, decision = 'approved', actor = 'admin', reason = 'Confirmed against independent gazetteer and country catalog.') =>
    request(app).post(`/api/admin/locality-proposals/${id}/decision`).set('Authorization', bearer(actor)).send({ decision, reason });
  const mine = (actor: string) => request(app).get('/api/geography/locality-proposals/mine').set('Authorization', bearer(actor));
  const count = async () => Number((await db.query('SELECT count(*) FROM localities')).rows[0].count);
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('./pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('./migrations/', import.meta.url);
      for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name) && name < '025').sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
      for (const role of ['creator','other','admin','dual','organizer','participant','guest','blocked','retired','revoked']) {
        const persisted = ['other','dual','guest','blocked','retired','revoked'].includes(role) ? 'creator' : role;
        const id = (await db.query(`INSERT INTO users (email,role,is_guest,account_status)
          VALUES ($1,$2,$3,$4) RETURNING id`, [`${role}@c6b3.invalid`,persisted,role === 'guest',
          ['blocked','retired'].includes(role) ? role : 'active'])).rows[0].id;
        await db.query('INSERT INTO user_roles (user_id,role) VALUES ($1,$2)', [id,persisted]);
        if (role === 'dual') await db.query("INSERT INTO user_roles (user_id,role) VALUES ($1,'admin')", [id]);
        actors[role] = id;
      }
      await db.query('DELETE FROM user_roles WHERE user_id=$1', [actors.revoked]);
      // Include a real finished Hunt snapshot as well as the seeded Signal Template.
      const org = (await db.query("INSERT INTO organizations (name,owner_id) VALUES ('History',$1) RETURNING id", [actors.creator])).rows[0].id;
      await db.query(`INSERT INTO hunts (organization_id,created_by_user_id,name,status,template_key,template_version,template_snapshot)
        VALUES ($1,$2,'Frozen history','finished','signal-cluj-napoca',1,'{"original":"frozen"}')`, [org,actors.creator]);
      historical = await history();
      migrations.push(proposalMigration);
      expect(await runMigrations(client, migrations)).toEqual(['025_locality_proposals']);
      expect(await runMigrations(client, migrations)).toEqual([]);
      expect(await history()).toEqual(historical);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    const postgres = await import('../lib/postgres.js'); closePool = () => postgres.pool.end();
    app = (await import('../app.js')).createApp(); signJwt = (await import('../lib/jwt.js')).signJwt;
  }, 30_000);
  afterAll(async () => {
    await closePool?.(); await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await admin.end();
  });

  it('submits pending facts owned by the Creator and restricts mine to its owner', async () => {
    const body = input();
    const before = await count();
    const result = await submit(body).expect(201);
    expect(result.body).toMatchObject({ ...body, creatorUserId: actors.creator, status: 'pending', localityId: null,
      reviewerUserId: null, decisionReason: null, decidedAt: null });
    expect((await mine('creator').expect(200)).body.proposals.map((p: { id: string }) => p.id)).toContain(result.body.id);
    expect((await mine('other').expect(200)).body.proposals).toEqual([]);
    expect(await count()).toBe(before);
    await request(app).get(`/api/geography/localities/${result.body.id}`).set('Authorization', bearer('creator')).expect(404);
    const search = await request(app).get('/api/geography/localities').query({ countryCode: 'RO', q: body.name })
      .set('Authorization', bearer('organizer')).expect(200);
    expect(search.body).toEqual({ localities: [], providerStatus: 'not_requested' });
    const queue = await request(app).get('/api/admin/locality-proposals').set('Authorization', bearer('admin')).expect(200);
    expect(queue.body.proposals).toContainEqual(result.body);
  });
  it('rejects missing, malformed, oversized, unsupported and restricted-source input', async () => {
    for (const field of Object.keys(input())) {
      const body: Record<string, unknown> = input(); delete body[field]; await submit(body).expect(400);
    }
    for (const override of [
      { countryCode: 'US' }, { countryCode: 'ro' }, { countryCode: 'ZZ' }, { name: ' ' }, { name: '---' },
      { name: 'x'.repeat(201) }, { administrativeContext: '' }, { administrativeContext: 'x'.repeat(201) },
      { latitude: 90.001 }, { latitude: -90.001 }, { longitude: 180.001 }, { longitude: -180.001 },
      { latitude: null }, { longitude: '23' }, { latitude: 'NaN' }, { latitude: 'Infinity' },
      { explanation: 'Coordinates copied from Mapbox temporary results' }, { explanation: 'too short' }, { explanation: 'x'.repeat(1001) }, { evidenceReference: 'https://example.org' },
      { evidenceReference: 'Mapbox temporary Search Box result for this town' },
      { evidenceReference: 'x'.repeat(1001) }, { evidenceReference: '12345678901234567890' },
      { status: 'approved' }, { creatorUserId: actors.other },
    ]) await submit({ ...input(), ...override }).expect(400);
    for (const latitude of [-90,90]) {
      const result = await submit({ ...input(), latitude, longitude: latitude * 2 }).expect(201);
      await decide(result.body.id, 'rejected').expect(200);
    }
  });
  it('denies non-Creators, guests and revoked/blocked identities despite forged role claims', async () => {
    for (const actor of ['organizer','participant','admin','guest','blocked','retired','revoked']) {
      const status = ['blocked','retired'].includes(actor) ? 401 : 403;
      await submit(input(), actor).expect(status); await mine(actor).expect(status);
    }
    await request(app).post('/api/geography/locality-proposals').send(input()).expect(401);
    await request(app).get('/api/geography/locality-proposals/mine').expect(401);
    for (const actor of ['creator','organizer','participant','guest','revoked','blocked','retired']) {
      const status = ['blocked','retired'].includes(actor) ? 401 : 403;
      await request(app).get('/api/admin/locality-proposals').set('Authorization', bearer(actor)).expect(status);
      await decide('invalid', 'approved', actor).expect(status);
    }
    await db.query("DELETE FROM user_roles WHERE user_id=$1 AND role='admin'", [actors.admin]);
    await request(app).get('/api/admin/locality-proposals').set('Authorization', bearer('admin')).expect(403);
    await decide('invalid').expect(403);
    await db.query("INSERT INTO user_roles (user_id,role) VALUES ($1,'admin')", [actors.admin]);
    await request(app).get('/api/admin/locality-proposals').expect(401);
    await request(app).post('/api/admin/locality-proposals/invalid/decision').send({}).expect(401);
  });
  it('validates decisions and prohibits self-review', async () => {
    const result = await submit(input(), 'dual').expect(201);
    await decide(result.body.id, 'approved', 'dual').expect(403);
    await decide(result.body.id, 'rejected', 'dual').expect(403);
    await decide(result.body.id, 'accepted').expect(400);
    await decide(result.body.id, 'approved', 'admin', '').expect(400);
    await decide('invalid').expect(400);
    await decide(randomUUID()).expect(404);
    for (const body of [{ decision: 'approved' }, { reason: 'An independent reason' }, { decision: 'approved', reason: 'Independent reason', localityId: randomUUID() }]) {
      await request(app).post(`/api/admin/locality-proposals/${result.body.id}/decision`)
        .set('Authorization', bearer('admin')).send(body).expect(400);
    }
  });
  it('approves exactly once, exposes a reusable Locality, and freezes decision history', async () => {
    const body = input(); const proposal = (await submit(body).expect(201)).body; const before = await count();
    const result = (await decide(proposal.id).expect(200)).body;
    expect(result).toMatchObject({ status: 'approved', reviewerUserId: actors.admin, decisionReason: expect.any(String),
      localityId: expect.any(String), decidedAt: expect.any(String) });
    expect(await count()).toBe(before + 1);
    const locality = await request(app).get(`/api/geography/localities/${result.localityId}`).set('Authorization', bearer('creator')).expect(200);
    expect(locality.body).toMatchObject({ id: result.localityId, name: body.name, active: true });
    expect(locality.body).not.toHaveProperty('evidenceReference');
    expect((await db.query('SELECT provider,provider_id,provenance FROM localities WHERE id=$1', [result.localityId])).rows[0])
      .toMatchObject({ provider: null, provider_id: null, provenance: expect.stringContaining(actors.admin) });
    for (const decision of ['approved','rejected']) await decide(proposal.id, decision).expect(409);
    for (const sql of ["UPDATE locality_proposals SET status='rejected',locality_id=NULL WHERE id=$1",
      "UPDATE locality_proposals SET decision_reason='Altered historical reason' WHERE id=$1",
      "UPDATE locality_proposals SET name='Changed facts' WHERE id=$1", 'DELETE FROM locality_proposals WHERE id=$1']) {
      await expect(db.query(sql, [proposal.id])).rejects.toMatchObject({ code: '23514' });
    }
    expect((await mine('creator')).body.proposals.find((p: { id: string }) => p.id === proposal.id)).toEqual(result);
    expect((await request(app).get('/api/admin/locality-proposals').set('Authorization', bearer('admin'))).body.proposals)
      .not.toContainEqual(result);
  });
  it('rejects without creating a locality and preserves pending submitted facts', async () => {
    const p = (await submit().expect(201)).body; const before = await count();
    await expect(db.query("UPDATE locality_proposals SET explanation='Changed after submission' WHERE id=$1", [p.id]))
      .rejects.toMatchObject({ code: '23514' });
    const result = await decide(p.id, 'rejected').expect(200);
    expect(result.body).toMatchObject({ status: 'rejected', localityId: null, reviewerUserId: actors.admin });
    expect(await count()).toBe(before); await decide(p.id).expect(409);
  });
  it('blocks normalized same-country names including inactive records; never silently merges', async () => {
    const name = `Conflict-${randomUUID()}`;
    const first = (await submit(input(name)).expect(201)).body;
    const approved = (await decide(first.id).expect(200)).body;
    await db.query('UPDATE localities SET active=false WHERE id=$1', [approved.localityId]);
    const other = (await submit({ ...input(name.toUpperCase().replaceAll('-', ' ')), administrativeContext: 'Other region', latitude: -40 }).expect(201)).body;
    const before = await count();
    await decide(other.id).expect(409, { error: 'locality_duplicate_conflict' });
    expect(await count()).toBe(before);
    expect((await db.query('SELECT status,locality_id,reviewer_user_id FROM locality_proposals WHERE id=$1', [other.id])).rows[0])
      .toEqual({ status: 'pending', locality_id: null, reviewer_user_id: null });
    await decide(other.id, 'rejected').expect(200);
    // Country scopes are independent and same coordinates alone are not identity.
    await db.query("INSERT INTO countries VALUES ('US','United States')");
    const foreign = (await submit({ ...input(name), countryCode: 'US' }).expect(201)).body;
    await decide(foreign.id).expect(200);
  });
  it('serializes identical and conflicting concurrent decisions on one proposal', async () => {
    for (const decisions of [['approved','approved'], ['approved','rejected']]) {
      const p = (await submit().expect(201)).body; const before = await count();
      const responses = await Promise.all(decisions.map(decision => decide(p.id, decision)));
      expect(responses.map(r => r.status).sort()).toEqual([200,409]);
      const winner = responses.find(r => r.status === 200)!;
      expect(await count()).toBe(before + (winner.body.status === 'approved' ? 1 : 0));
    }
  });
  it('serializes different proposals with the same normalized name under the country lock', async () => {
    const name = `Concurrent-${randomUUID()}`;
    const proposals = await Promise.all([submit(input(name)), submit(input(name.toUpperCase().replaceAll('-', ' ')))]);
    const before = await count();
    const results = await Promise.all(proposals.map(p => decide(p.body.id)));
    expect(results.map(r => r.status).sort()).toEqual([200,409]); expect(await count()).toBe(before + 1);
    expect(results.find(r => r.status === 409)!.body.error).toBe('locality_duplicate_conflict');
  });
  it('rolls back Locality creation when recording the decision fails', async () => {
    const p = (await submit().expect(201)).body; const before = await count();
    await db.query(`CREATE FUNCTION c6b3_fail_decision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${p.id}' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER c6b3_fail_decision BEFORE UPDATE ON locality_proposals FOR EACH ROW EXECUTE FUNCTION c6b3_fail_decision()`);
    try {
      await decide(p.id).expect(500); expect(await count()).toBe(before);
      expect((await db.query('SELECT status,locality_id FROM locality_proposals WHERE id=$1', [p.id])).rows[0])
        .toEqual({ status: 'pending', locality_id: null });
    } finally { await db.query('DROP TRIGGER c6b3_fail_decision ON locality_proposals; DROP FUNCTION c6b3_fail_decision()'); }
    await decide(p.id).expect(200);
  });
  it('enforces proposal bounds, decision/FK consistency and history dependencies in PostgreSQL', async () => {
    const p = (await submit().expect(201)).body;
    const row = (await db.query('SELECT * FROM locality_proposals WHERE id=$1', [p.id])).rows[0];
    for (const override of [{ latitude: 'NaN' }, { longitude: 'Infinity' }, { country_code: 'DE' }, { status: 'approved' },
      { evidence_reference: 'Mapbox temporary source for locality' }, { creator_user_id: randomUUID() }]) {
      const values = { ...row, id: randomUUID(), ...override }; const columns = Object.keys(values);
      await expect(db.query(`INSERT INTO locality_proposals (${columns.join(',')}) VALUES (${columns.map((_,i) => `$${i+1}`).join(',')})`, Object.values(values))).rejects.toBeDefined();
    }
    await expect(db.query('DELETE FROM users WHERE id=$1', [actors.creator])).rejects.toMatchObject({ code: '23503' });
  });
  it('preserves all Template and Hunt history and matches fresh schema constraints/indexes/triggers', async () => {
    expect(await history()).toEqual(historical);
    const client = await db.connect();
    const inspect = async () => ({
      constraints: (await client.query(`SELECT c.conname,pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=current_schema() AND t.relname='locality_proposals' ORDER BY c.conname`)).rows,
      indexes: (await client.query(`SELECT indexname,replace(indexdef,current_schema() || '.', '') AS definition
        FROM pg_indexes WHERE schemaname=current_schema() AND tablename='locality_proposals' ORDER BY indexname`)).rows,
      triggers: (await client.query(`SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='locality_proposals'
        AND NOT tgisinternal ORDER BY tgname`)).rows,
    });
    try {
      const upgraded = await inspect();
      await client.query('BEGIN; CREATE SCHEMA fresh_c6b3; SET LOCAL search_path TO fresh_c6b3,public');
      await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
      expect(await inspect()).toEqual(upgraded);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
