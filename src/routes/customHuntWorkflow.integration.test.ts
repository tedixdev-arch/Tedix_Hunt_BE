import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `custom_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;
const content = (key: string) => ({
  key, version: 1, displayName: 'School treasure trail', theme: 'Explore', mission: { name: 'Find the code' }, scoring: { startingScore: 100 },
  configuration: {
    normalCheckpointCount: 1,
    checkpointPositions: [{ checkpointNumber: 1, name: 'Square', latitude: 46.77, longitude: 23.62, radiusMeters: 30 }],
    finishPoint: { name: 'Finish', latitude: 46.78, longitude: 23.63, radiusMeters: 5 },
  },
  checkpoints: [{ checkpoint: 1, kind: 'hidden-rule' }, { role: 'terminal', navigationMode: 'none' }],
});

type Actor = { id: string; auth: string };
suite('Custom Hunt workflow against disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let applicationPool: Pool | undefined;
  let created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  let flushMail: typeof import('../lib/mail.js').flushMail;
  let reviewer: Actor, creator: Actor, otherCreator: Actor, organizer: Actor, outsider: Actor;
  let orgA: string, orgB: string, localityId: string;

  const actor = async (roles: string[]): Promise<Actor> => {
    const id = (await db.query(`INSERT INTO users (email, role, name) VALUES ($1, 'participant', 'Fixture') RETURNING id`,
      [`${randomUUID()}@example.invalid`])).rows[0].id;
    for (const role of roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, role]);
    return { id, auth: `Bearer ${signJwt({ sub: id, type: 'access', role: 'creator' })}` };
  };
  const send = (method: 'post' | 'put' | 'patch', path: string, body: object, who: Actor) =>
    request(app)[method](path).set('Authorization', who.auth).send(body);
  const get = (path: string, who: Actor) => request(app).get(path).set('Authorization', who.auth);
  const submitRequest = async (who = organizer, extra: object = {}) => (await send('post', '/api/custom-hunt-requests', {
    contactName: 'Ana Organizer', contactEmail: 'ana@example.invalid', city: 'Cluj-Napoca', preferredDate: '2027-05-01',
    participantCount: 40, details: 'Treasure trail for our school anniversary', ...extra,
  }, who).expect(201)).body.id as string;
  const localTemplate = async (who = creator) => {
    const key = `custom-${randomUUID()}`;
    await send('post', '/api/creator/templates', { key, content: content(key), category: 'local', localityId }, who).expect(201);
    return key;
  };
  const hunt = async (organizationId: string, who = organizer) =>
    (await send('post', '/api/hunts', { organizationId, name: 'Custom event' }, who).expect(201)).body.id as string;
  const outbox = async () => (await db.query(`SELECT kind, to_address, status FROM email_outbox ORDER BY created_at`)).rows;

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
    delete process.env.SMTP_URL;
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    applicationPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); signJwt = (await import('../lib/jwt.js')).signJwt;
    flushMail = (await import('../lib/mail.js')).flushMail;
    localityId = (await db.query(`INSERT INTO localities (country_code,name,administrative_context,latitude,longitude,provenance)
      VALUES ('RO','Cluj-Napoca','Cluj',46.77,23.6,'Reviewed registry fixture') RETURNING id`)).rows[0].id;
    reviewer = await actor(['admin']); creator = await actor(['creator']); otherCreator = await actor(['creator']);
    organizer = await actor(['organizer']); outsider = await actor(['organizer']);
    orgA = (await db.query(`INSERT INTO organizations(name, owner_id) VALUES ('Requesting school', $1) RETURNING id`, [organizer.id])).rows[0].id;
    orgB = (await db.query(`INSERT INTO organizations(name, owner_id) VALUES ('Other school', $1) RETURNING id`, [outsider.id])).rows[0].id;
    await db.query('INSERT INTO organization_members VALUES ($1,$2),($3,$4)', [orgA, organizer.id, orgB, outsider.id]);
  }, 30_000);
  afterAll(async () => {
    await applicationPool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it('runs request -> assign -> build -> approve -> exclusive Hunt with Organizer emails', async () => {
    const id = await submitRequest();
    let queue = (await get('/api/admin/custom-hunt-requests', reviewer).expect(200)).body.requests;
    expect(queue.find((r: any) => r.id === id)).toMatchObject({ status: 'new', organizationId: orgA, organizationName: 'Requesting school' });
    expect((await get('/api/custom-hunt-requests/mine', organizer).expect(200)).body.requests[0]).toMatchObject({ id, progress: 'in_work', note: null });
    expect((await get('/api/custom-hunt-requests/mine', outsider).expect(200)).body.requests).toEqual([]);

    await send('patch', `/api/admin/custom-hunt-requests/${id}`, { status: 'in_review', organizerNote: 'Looking at venues' }, reviewer).expect(200);
    await send('post', `/api/admin/custom-hunt-requests/${id}/assign`, { creatorUserId: organizer.id }, reviewer).expect(404, { error: 'creator_not_found' });
    const assigned = (await send('post', `/api/admin/custom-hunt-requests/${id}/assign`, { creatorUserId: creator.id }, reviewer).expect(200)).body;
    expect(assigned).toMatchObject({ status: 'assigned', assignedCreator: { id: creator.id } });

    const briefs = (await get('/api/creator/custom-requests', creator).expect(200)).body.requests;
    expect(briefs).toHaveLength(1); expect(briefs[0]).not.toHaveProperty('contactEmail'); expect(briefs[0]).not.toHaveProperty('adminNote');
    expect((await get('/api/creator/custom-requests', otherCreator).expect(200)).body.requests).toEqual([]);

    const key = await localTemplate();
    const foreign = await localTemplate(otherCreator);
    await send('put', `/api/creator/custom-requests/${id}/template`, { key: foreign }, creator).expect(404, { error: 'template_not_found' });
    await send('put', `/api/creator/custom-requests/${id}/template`, { key }, otherCreator).expect(404, { error: 'not_found' });
    expect((await send('put', `/api/creator/custom-requests/${id}/template`, { key }, creator).expect(200)).body)
      .toMatchObject({ status: 'in_progress', template: { key, status: 'draft' } });

    await send('post', `/api/creator/templates/${key}/submit`, { version: 1 }, creator).expect(200);
    await send('post', `/api/admin/templates/review/${key}/approve`, { version: 1 }, reviewer).expect(200);
    await flushMail();

    const mine = (await get('/api/custom-hunt-requests/mine', organizer).expect(200)).body.requests[0];
    expect(mine).toMatchObject({ progress: 'done', note: 'Looking at venues', hunt: { key, displayName: 'School treasure trail', locality: { id: localityId } } });
    expect(await outbox()).toEqual([
      { kind: 'custom_request.in_work', to_address: 'ana@example.invalid', status: 'logged' },
      { kind: 'custom_request.completed', to_address: 'ana@example.invalid', status: 'logged' },
    ]);

    // Exclusive: only the requesting organization discovers and selects it.
    const list = (who: Actor) => get(`/api/organizer/local-templates?countryCode=RO&localityId=${localityId}`, who).expect(200);
    const own = (await list(organizer)).body.templates.find((t: any) => t.key === key);
    expect(own).toMatchObject({ key, exclusive: true });
    expect((await list(outsider)).body.templates.some((t: any) => t.key === key)).toBe(false);
    const selection = { templateId: own.templateId, version: 1, countryCode: 'RO', localityId };
    await send('put', `/api/hunts/${await hunt(orgB, outsider)}/local-template`, selection, outsider).expect(409, { error: 'template_not_eligible' });
    await send('put', `/api/hunts/${await hunt(orgA)}/local-template`, selection, organizer).expect(200);

    // Finished requests are not reopened or reassigned.
    await send('patch', `/api/admin/custom-hunt-requests/${id}`, { status: 'new' }, reviewer).expect(409, { error: 'request_finalized' });
    await send('post', `/api/admin/custom-hunt-requests/${id}/assign`, { creatorUserId: creator.id }, reviewer).expect(409, { error: 'request_finalized' });
  });

  it('rejects with an Organizer note and email, releasing an unapproved linked template', async () => {
    await db.query('DELETE FROM email_outbox');
    const id = await submitRequest();
    await send('post', `/api/admin/custom-hunt-requests/${id}/assign`, { creatorUserId: creator.id }, reviewer).expect(200);
    const key = await localTemplate();
    await send('put', `/api/creator/custom-requests/${id}/template`, { key }, creator).expect(200);
    await send('post', `/api/admin/custom-hunt-requests/${id}/reject`, { organizerNote: '' }, reviewer).expect(400);
    await send('post', `/api/admin/custom-hunt-requests/${id}/reject`, { organizerNote: 'Venue is not accessible' }, reviewer).expect(200);
    expect((await db.query('SELECT custom_request_id FROM hunt_templates WHERE key=$1', [key])).rows[0].custom_request_id).toBeNull();
    const mine = (await get('/api/custom-hunt-requests/mine', organizer).expect(200)).body.requests.find((r: any) => r.id === id);
    expect(mine).toMatchObject({ progress: 'rejected', note: 'Venue is not accessible', hunt: null });
    expect((await outbox()).map(r => r.kind)).toEqual(['custom_request.in_work', 'custom_request.rejected']);
  });

  it('requires an organization before assignment and validates organization membership on submit', async () => {
    const anonymous = (await request(app).post('/api/custom-hunt-requests').send({ contactName: 'Guest', contactEmail: 'g@example.invalid', details: 'Need a hunt' }).expect(201)).body.id;
    await send('post', `/api/admin/custom-hunt-requests/${anonymous}/assign`, { creatorUserId: creator.id }, reviewer).expect(409, { error: 'organization_required' });
    await send('post', '/api/custom-hunt-requests', { contactName: 'A', contactEmail: 'a@example.invalid', details: 'x', organizationId: orgB }, organizer).expect(403, { error: 'organization_forbidden' });
  });

  it('deleting a linked draft returns the request to assigned; one template per request', async () => {
    const id = await submitRequest();
    await send('post', `/api/admin/custom-hunt-requests/${id}/assign`, { creatorUserId: creator.id }, reviewer).expect(200);
    const first = await localTemplate(); const second = await localTemplate();
    await send('put', `/api/creator/custom-requests/${id}/template`, { key: first }, creator).expect(200);
    await send('put', `/api/creator/custom-requests/${id}/template`, { key: second }, creator).expect(409, { error: 'request_already_linked' });
    await request(app).delete(`/api/creator/templates/${first}`).set('Authorization', creator.auth).expect(204);
    expect((await get('/api/admin/custom-hunt-requests', reviewer)).body.requests.find((r: any) => r.id === id)).toMatchObject({ status: 'assigned', template: null });
    await send('put', `/api/creator/custom-requests/${id}/template`, { key: second }, creator).expect(200);
  });
});
