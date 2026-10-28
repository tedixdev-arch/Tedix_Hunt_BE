import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import foundation from './migrations/024_country_locality.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const databaseName = `c6b1_${randomUUID().replaceAll('-', '')}`;
suite('Country/Locality foundation', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let closePool: () => Promise<void>;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  let geography: typeof import('../models/Geography.js').Geography;
  const actors: Record<string, string> = {};
  let localityId: string;
  let inactiveId: string;
  const migrations: Migration[] = [];
  const history = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ['hunt_templates', 'hunt_template_versions', 'hunt_template_reviews', 'hunts']) {
      result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;
    }
    return result;
  };
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('./pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('./migrations/', import.meta.url);
      for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name) && name < '024').sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
      const owner = (await db.query("INSERT INTO users (email,role) VALUES ('history@c6b1.invalid','creator') RETURNING id")).rows[0].id;
      const reviewer = (await db.query("INSERT INTO users (email,role) VALUES ('review@c6b1.invalid','admin') RETURNING id")).rows[0].id;
      const template = (await db.query(`INSERT INTO hunt_templates (key,origin,created_by_user_id,status,category)
        VALUES ('c6b1-history','creator',$1,'draft','local') RETURNING id`, [owner])).rows[0].id;
      await db.query(`INSERT INTO hunt_template_versions (template_id,version,content,origin,category,created_by_user_id)
        VALUES ($1,1,'{"key":"c6b1-history","version":1,"original":"preserved"}','creator','local',$2)`, [template, owner]);
      await db.query("UPDATE hunt_templates SET status='approved',submitted_version=1 WHERE id=$1", [template]);
      await db.query(`INSERT INTO hunt_template_reviews (template_id,version,reviewer_user_id,decision)
        VALUES ($1,1,$2,'approved')`, [template, reviewer]);
      const organization = (await db.query("INSERT INTO organizations (name,owner_id) VALUES ('C6b1 history',$1) RETURNING id", [owner])).rows[0].id;
      await db.query(`INSERT INTO hunts (organization_id,created_by_user_id,name,status,country,city,template_key,template_version,template_snapshot)
        VALUES ($1,$2,'History','finished','Romania','Cluj-Napoca','c6b1-history',1,'{"original":"frozen"}')`, [organization, owner]);
      const before = await history();
      migrations.push(foundation);
      expect(await runMigrations(client, migrations)).toEqual(['024_country_locality']);
      expect(await runMigrations(client, migrations)).toEqual([]);
      expect(await history()).toEqual(before);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js');
    environment.databaseUrl = url.toString();
    const postgres = await import('../lib/postgres.js');
    closePool = () => postgres.pool.end();
    app = (await import('../app.js')).createApp();
    signJwt = (await import('../lib/jwt.js')).signJwt;
    geography = (await import('../models/Geography.js')).Geography;
    for (const role of ['creator', 'organizer', 'admin', 'participant', 'guest', 'blocked', 'retired']) {
      const id = (await db.query(`INSERT INTO users (email,role,is_guest,account_status)
        VALUES ($1,$2,$3,$4) RETURNING id`, [`${role}@c6b1.invalid`,
        ['guest', 'blocked', 'retired'].includes(role) ? 'creator' : role,
        role === 'guest', ['blocked', 'retired'].includes(role) ? role : 'active'])).rows[0].id;
      await db.query('INSERT INTO user_roles (user_id,role) VALUES ($1,$2)', [id, ['guest', 'blocked', 'retired'].includes(role) ? 'creator' : role]);
      actors[role] = id;
    }
    for (const [context, active] of [['Cluj County', true], ['Different county', true], ['Historical county', false]] as const) {
      const id = (await db.query(`INSERT INTO localities
        (country_code,name,administrative_context,latitude,longitude,active,provenance)
        VALUES ('RO','Cluj-Napoca',$1,46.77,23.62,$2,'Test Admin confirmation, independently verified fixture') RETURNING id`, [context, active])).rows[0].id;
      if (active) localityId = id; else inactiveId = id;
    }
  }, 30_000);
  afterAll(async () => {
    await closePool?.(); await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await admin.end();
  });
  const bearer = (role: string) => `Bearer ${signJwt({ sub: actors[role], type: 'access' })}`;

  it('returns the initial country reference and distinct active matches without creating rows', async () => {
    expect(await geography.countries()).toEqual([{ code: 'RO', displayName: 'Romania' }]);
    for (const role of ['creator', 'organizer', 'admin']) {
      await request(app).get('/api/geography/countries').set('Authorization', bearer(role))
        .expect(200, { countries: [{ code: 'RO', displayName: 'Romania' }] });
      const response = await request(app).get('/api/geography/localities?countryCode=RO&q=cluj')
        .set('Authorization', bearer(role)).expect(200);
      expect(response.body.providerStatus).toBe('not_requested');
      expect(response.body.localities).toHaveLength(2);
      expect(response.body.localities[0]).toEqual(expect.objectContaining({ countryCode: 'RO', countryDisplayName: 'Romania', active: true }));
      expect(response.body.localities[0]).not.toHaveProperty('provenance');
      expect(response.body.localities[0]).not.toHaveProperty('providerId');
    }
    expect(await geography.search('RO', '%')).toEqual([]);
    expect(await geography.search('RO', '_')).toEqual([]);
    expect((await db.query('SELECT count(*) FROM localities')).rows[0].count).toBe('3');
  });
  it('resolves the exact UUID including inactive catalog entries', async () => {
    for (const [id, active] of [[localityId, true], [inactiveId, false]] as const) {
      const response = await request(app).get(`/api/geography/localities/${id}`).set('Authorization', bearer('creator')).expect(200);
      expect(response.body).toEqual(await geography.findById(id));
      expect(response.body.active).toBe(active);
    }
    await request(app).get(`/api/geography/localities/${randomUUID()}`).set('Authorization', bearer('creator')).expect(404);
  });
  it('authorizes every endpoint before validating or reading geography', async () => {
    for (const path of ['/countries', '/localities?countryCode=RO&q=Cluj', '/localities/invalid']) {
      await request(app).get(`/api/geography${path}`).expect(401);
      for (const role of ['participant', 'guest']) {
        await request(app).get(`/api/geography${path}`).set('Authorization', bearer(role)).expect(403);
      }
      for (const role of ['blocked', 'retired']) {
        await request(app).get(`/api/geography${path}`).set('Authorization', bearer(role)).expect(401);
      }
    }
    await db.query('DELETE FROM user_roles WHERE user_id=$1', [actors.organizer]);
    await request(app).get('/api/geography/countries').set('Authorization', bearer('organizer')).expect(403);
  });
  it('rejects unbounded, malformed, unsupported country and external-provider requests', async () => {
    for (const query of ['', '?countryCode=RO', '?countryCode=ZZ&q=Cluj', '?countryCode=ro&q=Cluj',
      '?countryCode=RO&q=', '?countryCode=RO&q=a&q=b', `?countryCode=RO&q=${'x'.repeat(101)}`,
      '?countryCode=RO&q=Cluj&includeProvider=true']) {
      await request(app).get(`/api/geography/localities${query}`).set('Authorization', bearer('creator')).expect(400);
    }
    await request(app).get('/api/geography/localities/invalid').set('Authorization', bearer('creator')).expect(400);
    await request(app).post('/api/geography/localities/resolve').set('Authorization', bearer('creator')).send({}).expect(404);
  });
  it('enforces ISO membership, nonblank bounded fields, finite coordinates, country FK and paired unique provider identity', async () => {
    await expect(db.query("INSERT INTO countries VALUES ('ZZ','Invalid')")).rejects.toMatchObject({ code: '23514' });
    const insert = `INSERT INTO localities (country_code,name,administrative_context,latitude,longitude,provenance,provider,provider_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    const valid = ['RO', 'Place', 'County', 0, 0, 'Admin confirmed fixture', null, null];
    for (const [index, value, code] of [
      [0, 'US', '23503'], [1, ' ', '23514'], [1, 'x'.repeat(201), '23514'],
      [2, '', '23514'], [3, 'NaN', '23514'], [3, 'Infinity', '23514'], [3, -91, '23514'],
      [4, 181, '23514'], [4, '-Infinity', '23514'], [5, '', '23514'],
      [6, 'provider', '23514'], [7, 'external-id', '23514'],
    ] as const) {
      const values = [...valid]; values[index] = value;
      await expect(db.query(insert, values)).rejects.toMatchObject({ code });
    }
    await db.query(insert, [...valid.slice(0, 6), 'fixture-provider', 'same-id']);
    await expect(db.query(insert, [...valid.slice(0, 6), 'fixture-provider', 'same-id'])).rejects.toMatchObject({ code: '23505' });
    await expect(db.query("DELETE FROM countries WHERE code='RO'")).rejects.toMatchObject({ code: '23503' });
  });
  it('matches fresh-schema constraints and indexes with the upgraded schema', async () => {
    const client = await db.connect();
    const inspect = async () => ({
      constraints: (await client.query(`SELECT t.relname,c.conname,pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=current_schema() AND t.relname IN ('countries','localities') ORDER BY t.relname,c.conname`)).rows,
      indexes: (await client.query(`SELECT indexname,replace(indexdef,current_schema() || '.', '') AS definition
        FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('countries','localities') ORDER BY indexname`)).rows,
    });
    try {
      const upgraded = await inspect();
      await client.query('BEGIN; CREATE SCHEMA fresh_c6b1; SET LOCAL search_path TO fresh_c6b1, public');
      await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
      expect(await inspect()).toEqual(upgraded);
      expect((await client.query('SELECT * FROM countries')).rows).toEqual([{ code: 'RO', display_name: 'Romania' }]);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
