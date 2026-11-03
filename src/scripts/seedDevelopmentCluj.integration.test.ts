import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { seedDevelopmentCluj } from './seedDevelopmentCluj.js';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite('development Cluj seed against PostgreSQL', () => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const name = `cluj_seed_${randomUUID().replaceAll('-', '')}`;
  let db: Pool, appPool: Pool, app: ReturnType<typeof import('../app.js').createApp>;
  let sign: typeof import('../lib/jwt.js').signJwt;
  const users: Record<string,string> = {};
  const get = (path: string, role = 'creator') => request(app).get(path).set('Authorization', `Bearer ${sign({sub:users[role],type:'access'})}`);
  const post = (path: string, body: object, role = 'creator') => request(app).post(path).set('Authorization', `Bearer ${sign({sub:users[role],type:'access'})}`).send(body);
  const seed = async (mode = 'development') => { const c = await db.connect(); try { return await seedDevelopmentCluj(c, mode); } finally { c.release(); } };
  const snapshot = async () => {
    const result: Record<string,unknown> = {};
    for (const table of ['countries','localities','geographic_imports','geographic_regions','geographic_cities','geographic_city_names','hunt_templates','hunt_template_versions','hunt_template_reviews','hunts']) {
      result[table] = (await db.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows;
    }
    return result;
  };
  const locality = async (active = true, name = 'Cluj-Napoca') => (await db.query(`INSERT INTO localities
    (country_code,name,administrative_context,latitude,longitude,active,provider,provider_id,provenance)
    VALUES('RO',$1,'Cluj County',46.7667,23.6,$2,'development-setup',$3,'Existing canonical fixture') RETURNING *`, [name,active,randomUUID()])).rows[0];
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${name}`;
    db = new Pool({connectionString:url.toString()});
    const c = await db.connect();
    try {
      await c.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations = [];
      for (const file of (await readdir(directory)).filter(file => /^\d{3}_.*\.ts$/.test(file)).sort()) {
        migrations.push((await import(new URL(file, directory).href)).default);
      }
      await runMigrations(c, migrations);
    } finally { c.release(); }
    for (const role of ['creator','admin','organizer']) {
      users[role] = (await db.query("INSERT INTO users(email,role) VALUES($1,$2) RETURNING id", [`${role}@cluj.invalid`,role])).rows[0].id;
      await db.query('INSERT INTO user_roles(user_id,role) VALUES($1,$2)', [users[role],role]);
    }
    (await import('../config/environment.js')).environment.databaseUrl = url.toString();
    appPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); sign = (await import('../lib/jwt.js')).signJwt;
  }, 30000);
  beforeEach(async () => {
    await db.query('TRUNCATE countries CASCADE');
    await db.query("INSERT INTO countries VALUES('RO','Romania')");
  });
  afterAll(async () => {
    app?.locals.stopAbuseProtection(); await appPool?.end(); await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end();
  });
  it('rejects every nondevelopment mode without writing', async () => {
    const before = await snapshot();
    for (const mode of ['production','test','']) await expect(seed(mode)).rejects.toThrow('NODE_ENV=development');
    expect(await snapshot()).toEqual(before);
  });
  it('seeds only one city/county and is fully idempotent, including concurrent runs', async () => {
    const results = await Promise.all([seed(),seed()]); expect(results[0]).toEqual(results[1]);
    const before = await snapshot(); expect(await seed()).toEqual(results[0]); expect(await snapshot()).toEqual(before);
    expect((await db.query('SELECT count(*) FROM localities')).rows[0].count).toBe('1');
    expect((await db.query('SELECT count(*) FROM geographic_imports')).rows[0].count).toBe('1');
    expect((await get('/api/geography/countries').expect(200)).body.countries).toContainEqual({code:'RO',displayName:'Romania'});
    expect((await get('/api/geography/regions?countryCode=RO').expect(200)).body.regions).toContainEqual(expect.objectContaining({admin1Code:'13',displayName:'Cluj'}));
    const city = (await get('/api/geography/cities?countryCode=RO&admin1Code=13&q=cluj').expect(200)).body.cities[0];
    expect(city).toMatchObject({...results[0],latitude:46.7712,longitude:23.6236,registeredActive:true,hasApprovedLocalTemplate:false});
    expect((await post('/api/geography/cities/681290/resolve', {}).expect(200)).body.localityId).toBe(results[0].localityId);
    expect((await get('/api/geography/localities?countryCode=RO&q=Cluj').expect(200)).body.localities[0].id).toBe(results[0].localityId);
    expect((await db.query("SELECT count(*) FROM hunt_templates WHERE category='local' AND status='approved'")).rows[0].count).toBe('0');
    const beforeDiscovery = await snapshot();
    await get('/api/organizer/geography/countries','organizer').expect(200,{countries:[{countryCode:'RO',displayName:'Romania'}],nextCursor:null});
    await get('/api/organizer/geography/regions?countryCode=RO','organizer').expect(200,{regions:[{regionId:'RO:admin1:13',countryCode:'RO',regionCode:'13',label:'Cluj',labelStatus:'resolved',level:'admin1'}],nextCursor:null});
    await get('/api/organizer/geography/cities?countryCode=RO&regionId=RO:admin1:13','organizer').expect(200,{cities:[{geographicId:'681290',countryCode:'RO',countryDisplayName:'Romania',localityId:results[0].localityId,name:'Cluj-Napoca',administrativeContext:'Cluj',regionCode:'13',regionDisplayName:'Cluj',regionId:'RO:admin1:13',source:'geonames',attribution:'GeoNames (CC BY 4.0)'}],nextCursor:null});
    await get(`/api/organizer/local-templates?countryCode=RO&localityId=${results[0].localityId}`,'organizer').expect(200,{templates:[],nextCursor:null});
    expect(await snapshot()).toEqual(beforeDiscovery);
  });
  it('discovers stored countries, counties without cities, and unregistered cities without approvals', async () => {
    const seeded = await seed();
    await db.query("INSERT INTO countries VALUES('HU','Hungary')");
    const run = (await db.query('SELECT import_id FROM geographic_cities WHERE geoname_id=681290')).rows[0].import_id;
    await db.query("INSERT INTO geographic_regions(country_code,admin1_code,display_name,import_id) VALUES('RO','99','Empty county',$1)", [run]);
    await db.query('UPDATE geographic_cities SET locality_id=NULL WHERE geoname_id=681290');
    const before = await snapshot();
    const countries = (await get('/api/organizer/geography/countries','organizer').expect(200)).body.countries;
    expect(countries).toContainEqual({countryCode:'HU',displayName:'Hungary'});
    const regions = (await get('/api/organizer/geography/regions?countryCode=RO','organizer').expect(200)).body.regions;
    expect(regions).toContainEqual({regionId:'RO:admin1:99',countryCode:'RO',regionCode:'99',label:'Empty county',labelStatus:'resolved',level:'admin1'});
    expect((await get('/api/organizer/geography/cities?countryCode=RO&regionId=RO:admin1:13','organizer').expect(200)).body.cities).toContainEqual(expect.objectContaining({geographicId:'681290',localityId:null}));
    expect((await get('/api/geography/cities?countryCode=RO&admin1Code=13&q=cluj').expect(200)).body.cities).toContainEqual(expect.objectContaining({geographicId:'681290',localityId:null}));
    await get(`/api/organizer/local-templates?countryCode=RO&localityId=${seeded.localityId}`,'organizer').expect(200,{templates:[],nextCursor:null});
    expect(await snapshot()).toEqual(before);
  });
  it('reuses a differently formatted canonical UUID without changing any locality fields', async () => {
    const existing = await locality(true,'Cluj Napoca');
    expect((await seed()).localityId).toBe(existing.id);
    expect((await db.query('SELECT * FROM localities')).rows).toEqual([existing]);
    expect((await get('/api/geography/cities/681290').expect(200)).body).toMatchObject({latitude:46.7712,longitude:23.6236,localityId:existing.id});
  });
  it.each(['inactive','ambiguous'])('refuses %s canonical references and rolls back the entire seed', async kind => {
    await locality(kind !== 'inactive'); if (kind === 'ambiguous') await locality();
    const before = await snapshot(); await expect(seed()).rejects.toThrow('reconciliation'); expect(await snapshot()).toEqual(before);
  });
  it('preserves existing source metadata/mapping and refuses incomplete imports atomically', async () => {
    await seed();
    await db.query("UPDATE geographic_cities SET latitude=46.7,source_modified='2026-12-01'");
    const before = await snapshot(); await seed(); expect(await snapshot()).toEqual(before);
    await db.query('UPDATE geographic_imports SET completed_at=NULL,row_count=NULL');
    const incomplete = await snapshot(); await expect(seed()).rejects.toThrow('incomplete'); expect(await snapshot()).toEqual(incomplete);
  });
  it('preserves drafts, versions, independent approval and legacy Hunts; location visibility survives C7 suspension', async () => {
    const existing = await locality();
    const content = {key:'seed-history',version:1,displayName:'Test route',theme:'Explore',mission:{name:'Find'},scoring:{startingScore:100},configuration:{normalCheckpointCount:1,checkpointPositions:[{checkpointNumber:1,name:'Start',latitude:46.7667,longitude:23.6,radiusMeters:25}],finishPoint:{name:'Finish',latitude:46.7667,longitude:23.6,radiusMeters:25}},checkpoints:[{checkpoint:1},{role:'terminal',navigationMode:'none'}]};
    const template = (await db.query("INSERT INTO hunt_templates(key,origin,category,created_by_user_id,status) VALUES($1,'creator','local',$2,'draft') RETURNING id", [content.key,users.creator])).rows[0].id;
    const snap = {id:existing.id,countryCode:'RO',countryDisplayName:'Romania',name:existing.name,administrativeContext:existing.administrative_context,latitude:existing.latitude,longitude:existing.longitude};
    await db.query("INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot) VALUES($1,1,$2,'creator','local',$3,$4,$5)", [template,content,users.creator,existing.id,snap]);
    await seed();
    expect((await get('/api/organizer/geography/countries','organizer').expect(200)).body.countries).toEqual([{countryCode:'RO',displayName:'Romania'}]);
    // Approval exists only in this disposable test database and uses the actual review flow.
    await post(`/api/creator/templates/${content.key}/submit`, {version:1}).expect(200);
    await post(`/api/admin/templates/review/${content.key}/approve`, {version:1,decision:'approved',notes:'Independent test review'}, 'admin').expect(200);
    const org = (await db.query("INSERT INTO organizations(name,owner_id) VALUES('Seed history',$1) RETURNING id", [users.organizer])).rows[0].id;
    await db.query("INSERT INTO hunts(organization_id,created_by_user_id,name,status,country,city,template_key,template_version,template_snapshot) VALUES($1,$2,'Legacy','finished','Romania','Cluj-Napoca',$3,1,$4)", [org,users.organizer,content.key,content]);
    await db.query("INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot) VALUES($1,2,$2,'creator','local',$3,$4,$5)", [template,{...content,version:2},users.creator,existing.id,snap]);
    const before = await snapshot(); await seed(); expect(await snapshot()).toEqual(before);
    expect((await get('/api/organizer/geography/cities?countryCode=RO&regionId=RO:admin1:13','organizer').expect(200)).body.cities).toContainEqual(expect.objectContaining({geographicId:'681290',localityId:existing.id}));
    expect((await get('/api/geography/cities/681290').expect(200)).body.hasApprovedLocalTemplate).toBe(true);
    await post(`/api/admin/templates/${content.key}/suspend`, {version:1,reason:'Test suspension'}, 'admin').expect(200);
    await seed();
    expect((await get('/api/organizer/geography/countries','organizer').expect(200)).body.countries).toEqual([{countryCode:'RO',displayName:'Romania'}]);
    await get(`/api/organizer/local-templates?countryCode=RO&localityId=${existing.id}`,'organizer').expect(200,{templates:[],nextCursor:null});
  });
});
