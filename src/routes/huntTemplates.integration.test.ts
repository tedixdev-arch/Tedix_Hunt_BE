import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

// Only create/drop our unique database; never reset the supplied database.
const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `d04_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;
const point = { name: 'Hidden', latitude: 46.771234, longitude: 23.623456, radiusMeters: 37 };
const configuration = { normalCheckpointCount: 1, checkpointPositions: [{ ...point, checkpointNumber: 1 }], finishPoint: { ...point, radiusMeters: 43 } };
const content = { displayName: 'Disposable trail', theme: 'Explore', configuration, checkpoints: [{ answer: 'D04_SECRET_ANSWER' }] };

suite('hidden Template geography against PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let pool: Pool | undefined;
  let created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  let owner: { id: string; auth: string };
  let approvedId: string;
  let huntId: string;

  const identity = async (roles: string[], options: { guest?: boolean; status?: string; primary?: string } = {}) => {
    const id = (await db.query(`INSERT INTO users (email, role, is_guest, account_status) VALUES ($1, $2, $3, $4) RETURNING id`,
      [`d04-${randomUUID()}@example.invalid`, options.primary ?? 'participant', options.guest ?? false, options.status ?? 'active'])).rows[0].id;
    for (const role of roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, role]);
    return { id, auth: `Bearer ${signJwt({ sub: id, type: 'access' })}` };
  };
  const template = async (key: string, saved: unknown = content, status = 'approved', origin = 'platform') => {
    const id = (await db.query(`INSERT INTO hunt_templates (key, origin, created_by_user_id, status) VALUES ($1, $2, $3, 'draft') RETURNING id`, [key, origin, owner.id])).rows[0].id;
    await db.query(`INSERT INTO hunt_template_versions (template_id, version, content, origin, created_by_user_id) VALUES ($1, 1, $2, $3, $4)`, [id, saved, origin, owner.id]);
    await db.query('UPDATE hunt_templates SET status = $2, submitted_version = $3 WHERE id = $1', [id, status, origin === 'creator' || status === 'submitted' ? 1 : null]);
    return id;
  };
  const noSecrets = (body: unknown) => {
    const serialized = JSON.stringify(body);
    for (const secret of ['latitude', 'longitude', 'radiusMeters', 'checkpointPositions', 'finishPoint', 'D04_SECRET_ANSWER', String(point.latitude), String(point.longitude)]) expect(serialized).not.toContain(secret);
  };

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name)).sort()) migrations.push((await import(new URL(filename, directory).href)).default);
      await runMigrations(client, migrations);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js');
    environment.databaseUrl = url.toString();
    pool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp();
    signJwt = (await import('../lib/jwt.js')).signJwt;
    owner = await identity(['creator']);
    approvedId = await template('d04-approved', content, 'approved', 'creator');
    await template('d04-review', content, 'submitted', 'creator');
    await template('d04-malformed-denied', { configuration: { finishPoint: { latitude: { answer: 'D04_SECRET_ANSWER' } } } });
    const orgId = (await db.query("INSERT INTO organizations (name, owner_id) VALUES ('D04 disposable', $1) RETURNING id", [owner.id])).rows[0].id;
    huntId = (await db.query(`INSERT INTO hunts (organization_id, created_by_user_id, name, status, template_key, template_version, template_snapshot, access_code) VALUES ($1, $2, 'D04 hunt', 'published', 'd04-approved', 1, $3, '7KPM4XQ2') RETURNING id`, [orgId, owner.id, content])).rows[0].id;
    await db.query("INSERT INTO hunt_roles (hunt_id, user_id, role) VALUES ($1, $2, 'organizer')", [huntId, owner.id]);
  }, 30_000);
  afterAll(async () => {
    await pool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it('rejects unauthenticated catalog and geography', async () => {
    for (const path of ['/api/hunt-templates', '/api/hunt-templates/d04-approved/geography']) noSecrets((await request(app).get(path).expect(401)).body);
  });
  it.each([
    { label: 'guest', roles: ['participant'], guest: true },
    { label: 'guest with professional rows', roles: ['creator', 'organizer', 'admin'], guest: true },
    { label: 'Participant-only', roles: ['participant'] },
    { label: 'legacy primary Creator without capability', roles: ['participant'], primary: 'creator' },
    { label: 'blocked professional', roles: ['admin'], status: 'blocked' },
    { label: 'retired professional', roles: ['admin'], status: 'retired' },
  ])('denies $label across catalog and alternative inspection routes', async scenario => {
    const user = await identity(scenario.roles, scenario);
    const expected = scenario.status ? 401 : 403;
    for (const path of ['/api/hunt-templates', '/api/hunt-templates/d04-approved/geography', '/api/hunt-templates/d04-malformed-denied/geography', '/api/hunt-templates/unknown/geography', '/api/hunt-templates/%20/geography', '/api/creator/templates', '/api/creator/templates/d04-approved', '/api/admin/templates/review', '/api/admin/templates/review/d04-review', `/api/hunts/${huntId}`]) {
      const response = await request(app).get(path).set('Authorization', user.auth).expect(expected);
      expect(response.body).toEqual({ error: expected === 401 ? 'unauthorized' : 'forbidden' }); noSecrets(response.body);
    }
    noSecrets((await request(app).get('/api/hunts').set('Authorization', user.auth).expect(scenario.status ? 401 : 200)).body);
  });
  it.each([['creator'], ['organizer'], ['admin'], ['participant', 'creator'], ['participant', 'organizer'], ['participant', 'admin']])('permits authoritative professional roles %j with Participant primary role', async (...roles) => {
    const user = await identity(roles);
    const catalog = await request(app).get('/api/hunt-templates').set('Authorization', user.auth).expect(200);
    noSecrets(catalog.body);
    expect(catalog.body).toContainEqual({ key: 'd04-approved', version: 1, displayName: content.displayName, theme: content.theme });
    const response = await request(app).get('/api/hunt-templates/d04-approved/geography?version=999').set('Authorization', user.auth).expect(200);
    expect(response.body).toEqual({ key: 'd04-approved', version: 1, configuration });
    expect(JSON.stringify(response.body)).not.toContain('D04_SECRET_ANSWER');
  });
  it('preserves Creator authoring, Admin exact-version review and assigned Hunt preview', async () => {
    const creator = await request(app).get('/api/creator/templates/d04-approved').set('Authorization', owner.auth).expect(200);
    expect(creator.body.content.configuration).toEqual(configuration);
    const reviewer = await identity(['admin']);
    const review = await request(app).get('/api/admin/templates/review/d04-review').set('Authorization', reviewer.auth).expect(200);
    expect(review.body.content.configuration).toEqual(configuration);
    const hunt = await request(app).get(`/api/hunts/${huntId}`).set('Authorization', owner.auth).expect(200);
    expect(hunt.body.templateSnapshot).toEqual(content);
    noSecrets((await request(app).get('/api/hunt-access/7KPM4XQ2').expect(200)).body);
  });
  it('rechecks professional capability on every request using the same access token', async () => {
    const user = await identity(['participant', 'organizer']);
    await request(app).get('/api/hunt-templates/d04-approved/geography').set('Authorization', user.auth).expect(200);
    await db.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'organizer'", [user.id]);
    for (const path of ['/api/hunt-templates', '/api/hunt-templates/d04-approved/geography']) {
      noSecrets((await request(app).get(path).set('Authorization', user.auth).expect(403, { error: 'forbidden' })).body);
    }
  });
  it('preserves legacy/malformed handling and invalid-key behavior', async () => {
    await template('d04-empty', { displayName: 'Legacy', theme: 'Explore' });
    await template('d04-malformed', { configuration: { finishPoint: { latitude: { answer: 'D04_SECRET_ANSWER' } } } });
    await request(app).get('/api/hunt-templates/d04-empty/geography').set('Authorization', owner.auth).expect(200, { key: 'd04-empty', version: 1, configuration: {} });
    noSecrets((await request(app).get('/api/hunt-templates/d04-malformed/geography').set('Authorization', owner.auth).expect(409, { error: 'template_geography_unavailable' })).body);
    for (const key of ['unknown', '%20', 'd04-review']) noSecrets((await request(app).get(`/api/hunt-templates/${key}/geography`).set('Authorization', owner.auth).expect(404, { error: 'not_found' })).body);
  });
  it('keeps the approved pin and Hunt snapshot immutable when newer versions exist', async () => {
    const before = (await db.query('SELECT template_snapshot FROM hunts WHERE id = $1', [huntId])).rows[0];
    await db.query(`INSERT INTO hunt_template_versions (template_id, version, content, origin, created_by_user_id) VALUES ($1, 2, $2, 'creator', $3)`, [approvedId, { ...content, configuration: { finishPoint: { ...point, latitude: 1 } } }, owner.id]);
    await request(app).get('/api/hunt-templates/d04-approved/geography').set('Authorization', owner.auth).expect(200, { key: 'd04-approved', version: 1, configuration });
    expect((await db.query('SELECT template_snapshot FROM hunts WHERE id = $1', [huntId])).rows[0]).toEqual(before);
  });
});
