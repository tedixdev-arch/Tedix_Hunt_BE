import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const templateName = `cluj_seed_${randomUUID().replaceAll('-', '')}`;
const rolePassword = randomBytes(24).toString('hex');
const rawSql = await readFile(new URL('../../scripts/development/cluj-locality.sql', import.meta.url), 'utf8');

suite('pgAdmin Cluj seed on real disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool, app: Pool;
  let configuredSql: string;
  let createdDatabase = false, createdRole = false, createdTemplate = false;
  beforeAll(async () => {
    // This suite deliberately uses the real deployment DB/role names in a disposable cluster only.
    const url = new URL(testUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/tedix_test') {
      throw new Error('Seed integration tests require a dedicated local disposable tedix_test cluster');
    }
    await admin.query(`CREATE ROLE tedix_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${rolePassword}'`);
    createdRole = true;
    await admin.query(`CREATE DATABASE "${templateName}"`); createdTemplate = true;
    url.pathname = `/${templateName}`;
    const template = new Pool({ connectionString: url.href });
    const client = await template.connect();
    try {
      await client.query(await readFile(new URL('./pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('./migrations/', import.meta.url), migrations: Migration[] = [];
      for (const file of (await readdir(directory)).filter(file => /^\d{3}_.*\.ts$/.test(file)).sort()) {
        migrations.push((await import(new URL(file, directory).href)).default);
      }
      await runMigrations(client, migrations);
      await client.query('GRANT USAGE ON SCHEMA public TO tedix_app');
      await client.query('GRANT SELECT ON public.countries, public.localities TO tedix_app');
      await client.query('GRANT INSERT, UPDATE ON public.localities TO tedix_app');
    } finally { client.release(); await template.end(); }
  });
  beforeEach(async () => {
    await admin.query(`CREATE DATABASE tedix_hunt TEMPLATE "${templateName}"`); createdDatabase = true;
    const url = new URL(testUrl!); url.pathname = '/tedix_hunt';
    db = new Pool({ connectionString: url.href });
    url.username = 'tedix_app'; url.password = rolePassword;
    app = new Pool({ connectionString: url.href });
    const endpoint = (await app.query('SELECT inet_server_addr()::text AS address, inet_server_port() AS port')).rows[0];
    configuredSql = rawSql.replace("expected_server_address text := 'REPLACE_WITH_REVIEWED_DEV_SERVER_ADDRESS'", `expected_server_address text := '${endpoint.address}'`)
      .replace('expected_server_port integer := 0;', `expected_server_port integer := ${endpoint.port};`);
  });
  afterEach(async () => {
    await app?.end(); await db?.end();
    if (createdDatabase) {
      await expect.poll(async () => (await admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname='tedix_hunt'")).rows[0].count).toBe('0');
      await admin.query('DROP DATABASE tedix_hunt'); createdDatabase = false;
    }
  });
  afterAll(async () => {
    if (createdTemplate) await admin.query(`DROP DATABASE "${templateName}"`);
    if (createdRole) await admin.query('DROP ROLE tedix_app');
    await admin.end();
  });
  const locality = async (active = true, name = 'Cluj Napoca', context = 'Cluj County') => (await db.query(`
    INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,active,provenance)
    VALUES ('RO',$1,$2,46.77,23.62,$3,'Existing reviewed registry reference') RETURNING *`, [name, context, active])).rows[0];
  const history = async () => {
    const result: Record<string, unknown> = {};
    for (const table of ['hunt_templates', 'hunt_template_versions', 'hunt_template_reviews', 'locality_proposals', 'geographic_cities', 'geographic_imports']) {
      result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    }
    return result;
  };
  it('creates one real UUID, repeats without modification and never changes catalog/approvals', async () => {
    const before = await history(); await app.query(configuredSql);
    const first = (await db.query('SELECT * FROM localities')).rows;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ country_code: 'RO', name: 'Cluj-Napoca', active: true, provider: 'development-setup' });
    expect(first[0].id).toMatch(/^[0-9a-f-]{36}$/);
    await app.query(configuredSql);
    expect((await db.query('SELECT * FROM localities')).rows).toEqual(first);
    expect(await history()).toEqual(before);
  });
  it('reuses an existing valid Cluj UUID, coordinates, context and provenance exactly', async () => {
    const existing = await locality(); await app.query(configuredSql);
    expect((await db.query('SELECT * FROM localities')).rows).toEqual([existing]);
  });
  it.each(['inactive', 'ambiguous'])('refuses %s registry candidates without mutations', async mode => {
    await locality(mode !== 'inactive'); if (mode === 'ambiguous') await locality();
    const before = (await db.query('SELECT * FROM localities ORDER BY id')).rows;
    await expect(app.query(configuredSql)).rejects.toThrow(/Admin reconciliation/);
    expect((await db.query('SELECT * FROM localities ORDER BY id')).rows).toEqual(before);
  });
  it('refuses unconfigured or wrong endpoint, role and database', async () => {
    await expect(app.query(rawSql)).rejects.toThrow(/server address/);
    await expect(app.query(configuredSql.replace(/expected_server_port integer := \d+;/, 'expected_server_port integer := 1;'))).rejects.toThrow(/server address/);
    await expect(app.query(configuredSql.replace(/expected_server_address text := '[^']+'/ , "expected_server_address text := '192.0.2.1'"))).rejects.toThrow(/server address/);
    await expect(db.query(configuredSql)).rejects.toThrow(/login\/current role/);
    const wrongDbUrl = new URL(testUrl!); wrongDbUrl.username = 'tedix_app'; wrongDbUrl.password = rolePassword;
    const wrongDb = new Pool({ connectionString: wrongDbUrl.href });
    try { await expect(wrongDb.query(configuredSql)).rejects.toThrow(/database tedix_hunt/); } finally { await wrongDb.end(); }
    expect((await db.query('SELECT count(*) FROM localities')).rows[0].count).toBe('0');
  });
  it('rolls back when country is missing without creating a fake country', async () => {
    await db.query("DELETE FROM countries WHERE code='RO'");
    await expect(app.query(configuredSql)).rejects.toMatchObject({ code: '23503' });
    expect((await db.query('SELECT count(*) FROM localities')).rows[0].count).toBe('0');
  });
  it('removal retains actual Template version locality/snapshot, and never reactivates it', async () => {
    await app.query(configuredSql);
    const place = (await db.query('SELECT * FROM localities')).rows[0];
    const owner = (await db.query("INSERT INTO users(email,role) VALUES ('cluj-seed-test@example.invalid','creator') RETURNING id")).rows[0].id;
    const template = (await db.query("INSERT INTO hunt_templates(key,origin,status,category,created_by_user_id) VALUES ('cluj-seed-test','creator','draft','local',$1) RETURNING id", [owner])).rows[0].id;
    await db.query(`INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot)
      VALUES ($1,1,'{"key":"cluj-seed-test","version":1}','creator','local',$2,$3,$4::jsonb)`, [template, owner, place.id, JSON.stringify({ id: place.id, countryCode: 'RO', countryDisplayName: 'Romania', name: place.name, administrativeContext: place.administrative_context, latitude: place.latitude, longitude: place.longitude })]);
    const before = await history();
    const remove = configuredSql.replace("action text := 'apply'", "action text := 'remove'");
    await app.query(remove); await app.query(remove);
    expect((await db.query('SELECT id,active FROM localities')).rows).toEqual([{ id: place.id, active: false }]);
    expect(await history()).toEqual(before);
    await expect(app.query(configuredSql)).rejects.toThrow(/Admin reconciliation/);
  });
  it('concurrent executions serialize and create only one UUID', async () => {
    await Promise.all([app.query(configuredSql), app.query(configuredSql)]);
    expect((await db.query('SELECT count(*) FROM localities')).rows[0].count).toBe('1');
  });
  it('removal cannot change a reused registry-owned reference', async () => {
    const existing = await locality(); await app.query(configuredSql);
    await app.query(configuredSql.replace("action text := 'apply'", "action text := 'remove'"));
    expect((await db.query('SELECT * FROM localities')).rows).toEqual([existing]);
  });
});
