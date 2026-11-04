import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';
import { exerciseFixtures } from '../test/customExercises.js';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `library_content_${randomUUID().replaceAll('-', '')}`;
const root = '/api/creator/content';
type Actor = { id: string; auth: string };
(testUrl ? describe : describe.skip)('Content Library API and migration against disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool, applicationPool: Pool | undefined, created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;

  let owner: Actor, other: Actor, reviewer: Actor, participant: Actor;

  const actor = async (roles: string[]): Promise<Actor> => {
    const id = (await db.query("INSERT INTO users(email,role) VALUES ($1,'participant') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0].id;
    for (const role of roles) await db.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [id, role]);
    return { id, auth: `Bearer ${signJwt({ sub: id, type: 'access' })}` };
  };
  const post=(body:any,who=owner)=>request(app).post(root).set('Authorization',who.auth).send(body);
  const get=(path:string,who=owner)=>request(app).get(path).set('Authorization',who.auth);
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
      expect(applied).toContain('042_content_library');
      expect(await runMigrations(client, migrations)).toEqual([]);
    } finally { client.release(); }
    (await import('../config/environment.js')).environment.databaseUrl = url.toString();
    applicationPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); signJwt = (await import('../lib/jwt.js')).signJwt;
    owner = await actor(['creator', 'organizer']); other = await actor(['creator']); reviewer = await actor(['admin']);
    participant = await actor(["participant"]);
  }, 30000);
  afterAll(async () => {
    app?.locals.stopAbuseProtection?.();
    await applicationPool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });


 for(const exercise of exerciseFixtures) it(`${exercise.type}: complete PostgreSQL round trip`,async()=>{
  const e={...exercise,instructions:'Solve $\\frac{1}{2}$; ă π ≥ 2\n  preserve'};
  const saved=(await post({exercise:e}).expect(201)).body;
  expect(saved.exercise).toEqual(e); expect(saved.ownerId).toBe(owner.id);
  expect((await get(`${root}/${saved.contentId}`).expect(200)).body).toEqual(saved);
  expect((await post({exercise:{...e,answer:{}}}).expect(400)).body.error).toBe('invalid_content');
 });
 it('enforces roles, authentication, ownership and malformed input',async()=>{
  const saved=(await post({exercise:exerciseFixtures[0]}).expect(201)).body;
  await request(app).get(root).expect(401);
  await post({exercise:exerciseFixtures[0]},participant).expect(403);
  await post({exercise:exerciseFixtures[0]},reviewer).expect(403);
  await get(`${root}/${saved.contentId}`,other).expect(404);
  await request(app).put(`${root}/${saved.contentId}`).set('Authorization',other.auth).send({exercise:exerciseFixtures[0],baseRevisionId:saved.revisionId}).expect(404);
  await get(`${root}/invalid`).expect(400);
  await get(`${root}?limit=oops`).expect(400);
  await post(null).expect(400);
  await post({exercise:exerciseFixtures[0],category:'All'}).expect(400);
  const guest=await actor(['creator']);
  await db.query('UPDATE users SET is_guest=true WHERE id=$1',[guest.id]);
  await get(root,guest).expect(403);
  const blocked=await actor(['creator']);
  await db.query("UPDATE users SET account_status='blocked' WHERE id=$1",[blocked.id]);
  await get(root,blocked).expect(401);
  await get(`${root}/${saved.contentId}/revisions/${saved.revisionId}`,other).expect(404);
  await request(app).post(root).set('Authorization',owner.auth).set('Content-Type','application/json').send('{').expect(400);
 });
 it('appends revisions, rejects stale writes and protects approved payloads in SQL',async()=>{
  const a=(await post({exercise:exerciseFixtures[0]}).expect(201)).body;
  const url=`${root}/${a.contentId}`;
  const update=()=>request(app).put(url).set('Authorization',owner.auth).send({exercise:{...a.exercise,title:'Revised'},baseRevisionId:a.revisionId});
  const b=(await update().expect(200)).body;
  expect(b.version).toBe(2); expect(b.revisionId).not.toBe(a.revisionId);
  await update().expect(409);
  expect((await get(`${url}/revisions/${a.revisionId}`).expect(200)).body.exercise).toEqual(a.exercise);
  await db.query("UPDATE library_content_revisions SET status='approved' WHERE id=$1",[b.revisionId]);
  await request(app).put(url).set('Authorization',owner.auth).send({exercise:a.exercise,baseRevisionId:b.revisionId}).expect(409);
  await expect(db.query("UPDATE library_content_revisions SET exercise='{}' WHERE id=$1",[b.revisionId])).rejects.toThrow();
  await expect(db.query('DELETE FROM library_content_revisions WHERE id=$1',[b.revisionId])).rejects.toThrow();
  await expect(db.query("UPDATE library_content SET owner_id=$2 WHERE id=$1",[a.contentId,other.id])).rejects.toThrow();
  const c=(await request(app).post(`${url}/revisions`).set('Authorization',owner.auth).send({baseRevisionId:b.revisionId}).expect(201)).body;
  expect(c.status).toBe('draft'); expect(c.exercise).toEqual(b.exercise);
  expect((await get(`${url}/revisions/${b.revisionId}`).expect(200)).body.status).toBe('approved');
  const attempts=await Promise.all([1,2].map(()=>request(app).put(url).set('Authorization',owner.auth).send({exercise:a.exercise,baseRevisionId:c.revisionId})));
  expect(attempts.map(r=>r.status).sort()).toEqual([200,409]);
 });
 it('uses real geography foreign keys and defaults to universal',async()=>{
  const e=exerciseFixtures[0];
  expect((await post({exercise:e}).expect(201)).body.geography).toEqual({scope:'universal'});
  const country=(await db.query('SELECT code FROM countries LIMIT 1')).rows[0].code;
  expect((await post({exercise:e,geography:{scope:'country',countryCode:country}}).expect(201)).body.geography.countryCode).toBe(country);
  await post({exercise:e,geography:{scope:'country',countryCode:'ZZ'}}).expect(400);
  await post({exercise:e,geography:{scope:'region',countryCode:country,admin1Code:'missing'}}).expect(400);
  await post({exercise:e,geography:{scope:'city',countryCode:country,geographicId:'999999999'}}).expect(400);
  const importId=(await db.query("INSERT INTO geographic_imports(source,dataset,sha256,attribution) VALUES ('geonames','test',repeat('a',64),'GeoNames (CC BY 4.0)') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO geographic_regions(country_code,admin1_code,display_name,import_id) VALUES ($1,'13','Test region',$2)",[country,importId]);
  await db.query(`INSERT INTO geographic_cities(geoname_id,country_code,name,administrative_context,admin1_code,admin2_code,latitude,longitude,population,source_modified,import_id)
   VALUES (900,$1,'Test city','Test region','13','',46,23,1,'2026-01-01',$2)`,[country,importId]);
  for(const geography of [{scope:'region',countryCode:country,admin1Code:'13'},{scope:'city',countryCode:country,geographicId:'900'}])
   expect((await post({exercise:e,category:'Mathematics',curriculum:{subject:'math',grade:'5'},geography}).expect(201)).body.geography).toEqual(geography);
    const list=(await get(root).expect(200)).body;
  expect(list.items.every((i:any)=>i.ownerId===owner.id&&i.status==='draft')).toBe(true);
 });
});
