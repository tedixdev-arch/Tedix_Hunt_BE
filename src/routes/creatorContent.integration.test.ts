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
      expect(applied).toContain('043_content_review');
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
  await expect(db.query("UPDATE library_content_revisions SET status='approved' WHERE id=$1",[b.revisionId])).rejects.toThrow();
  // Existing C2a draft update stays append-only; review now uses the guarded API.
  const classified=(await request(app).put(url).set('Authorization',owner.auth).send({exercise:a.exercise,category:'Science',baseRevisionId:b.revisionId}).expect(200)).body;
  b.revisionId=classified.revisionId; b.exercise=classified.exercise;
  await request(app).post(`${url}/revisions/${b.revisionId}/submit`).set('Authorization',owner.auth).send({}).expect(200);
  await request(app).post(`/api/admin/content/review/${a.contentId}/revisions/${b.revisionId}/approve`).set('Authorization',reviewer.auth).send({}).expect(200);
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
 const adminRoot='/api/admin/content/review';
 const create=async(who=owner,category:string|null='Science')=>(await post({exercise:exerciseFixtures[0],category},who).expect(201)).body;
 const submit=(r:any,who=owner)=>request(app).post(`${root}/${r.contentId}/revisions/${r.revisionId}/submit`).set('Authorization',who.auth).send({});
 const decide=(r:any,action='approve',who=reviewer,body:any={})=>request(app).post(`${adminRoot}/${r.contentId}/revisions/${r.revisionId}/${action}`).set('Authorization',who.auth).send(body);
 const detail=(r:any,who=reviewer)=>get(`${adminRoot}/${r.contentId}/revisions/${r.revisionId}`,who);
 it('owner submits once without creating a revision; submitted heads remain discoverable and immutable',async()=>{
  const r=await create();
  await submit(r,other).expect(404);
  await submit(r,participant).expect(403);
  const submitted=(await submit(r).expect(200)).body;
  expect(submitted).toMatchObject({revisionId:r.revisionId,version:r.version,status:'submitted',exercise:r.exercise});
  expect(submitted.reviewEvents).toHaveLength(1);
  expect(submitted.reviewEvents[0]).toMatchObject({actorUserId:owner.id,decision:'submitted',revisionId:r.revisionId});
  await submit(r).expect(409);
  expect((await get(`${root}?view=all`).expect(200)).body.items.some((i:any)=>i.revisionId===r.revisionId)).toBe(true);
  expect((await get(root).expect(200)).body.items.some((i:any)=>i.revisionId===r.revisionId)).toBe(false);
  expect((await get(`${root}/${r.contentId}`).expect(200)).body.status).toBe('submitted');
  await request(app).post(`${root}/${r.contentId}/revisions`).set('Authorization',owner.auth).send({baseRevisionId:r.revisionId}).expect(409);
  await request(app).put(`${root}/${r.contentId}`).set('Authorization',owner.auth).send({exercise:r.exercise,baseRevisionId:r.revisionId}).expect(409);
 });
 it('submission validates complete stored canonical exercise and requires category without imposing math curriculum',async()=>{
  const draft=await create(owner,null);
  await submit(draft).expect(400);
  // C2a SQL constraints allow legacy incomplete JSON; submission must revalidate it.
  const client=await db.connect();
  let corrupt:any;
  try {
   await client.query('BEGIN');
   const id=(await client.query('INSERT INTO library_content(owner_id,head_version) VALUES ($1,1) RETURNING id',[owner.id])).rows[0].id;
   const rev=(await client.query(`INSERT INTO library_content_revisions(content_id,version,exercise,category,geographic_scope)
    VALUES ($1,1,'{"classification":"personal"}','Science','universal') RETURNING id`,[id])).rows[0].id;
   await client.query('COMMIT'); corrupt={contentId:id,revisionId:rev};
  } finally {client.release();}
  const invalid=await submit(corrupt).expect(400);
  expect(invalid.body.error).toBe('invalid_content');
  expect((await get(`${root}/${corrupt.contentId}`).expect(200)).body).toMatchObject({status:'draft',reviewEvents:[]});
  const nonMath=await create();
  expect((await submit(nonMath).expect(200)).body.curriculum).toEqual({});
 });
 it('Admin sees exact canonical detail and paginated classification queue without personal information',async()=>{
  const r=await create();await submit(r).expect(200);
  await detail(r,owner).expect(403);
  const inspected=(await detail(r).expect(200)).body;
  expect(inspected).toMatchObject({revisionId:r.revisionId,ownerId:owner.id,exercise:r.exercise,geography:r.geography,status:'submitted'});
  const first=(await get(`${adminRoot}?limit=1`,reviewer).expect(200)).body;
  expect(first.items).toHaveLength(1);expect(first.nextAfter).toBeTruthy();
  const next=(await get(`${adminRoot}?limit=1&after=${first.nextAfter}`,reviewer).expect(200)).body;
  expect(next.items[0].revisionId).not.toBe(first.items[0].revisionId);
  for(const row of [...first.items,...next.items]){
   expect(row.classification).toBe('personal');expect(row.submittedAt).toBeTruthy();
   expect(row).not.toHaveProperty('email');expect(row).not.toHaveProperty('exercise');expect(row).not.toHaveProperty('ownerId');
  }
  await get(`${adminRoot}?limit=0`,reviewer).expect(400);
  await get(`${adminRoot}?after=invalid`,reviewer).expect(400);
  await detail({...r,contentId:randomUUID()}).expect(404);
  await get(`${adminRoot}/${r.contentId}/revisions/invalid`,reviewer).expect(400);
 });
 it('independent Admin approves exact revision; duplicate and wrong pairs reject, with intact audit and historical approval',async()=>{
  const r=await create();const wrong=await create();await submit(r).expect(200);
  await decide(r,'approve',owner).expect(403);
  await decide({...r,contentId:wrong.contentId}).expect(404);
  await decide(r,'approve',reviewer,{exercise:r.exercise}).expect(400);
  const approved=(await decide(r).expect(200)).body;
  expect(approved).toMatchObject({revisionId:r.revisionId,status:'approved',exercise:r.exercise,version:1});
  expect(approved.reviewEvents).toHaveLength(2);
  expect(approved.reviewEvents[1]).toMatchObject({revisionId:r.revisionId,contentId:r.contentId,actorUserId:reviewer.id,decision:'approved',comment:null});
  expect(Date.parse(approved.reviewEvents[1].decidedAt)).toBeGreaterThan(0);
  await decide(r).expect(409); await decide(r,'request-changes',reviewer,{comment:'Please revise wording'}).expect(409);
  await expect(db.query("UPDATE library_content_revisions SET exercise=exercise||'{\"title\":\"changed\"}' WHERE id=$1",[r.revisionId])).rejects.toThrow();
  const draft=(await request(app).post(`${root}/${r.contentId}/revisions`).set('Authorization',owner.auth).send({baseRevisionId:r.revisionId}).expect(201)).body;
  expect(draft).toMatchObject({status:'draft',version:2,exercise:r.exercise,reviewEvents:[]});
  const history=(await get(`${root}/${r.contentId}/revisions/${r.revisionId}`).expect(200)).body;
  expect(history).toEqual(approved);
  await expect(db.query("UPDATE library_content_review_events SET comment='Edited' WHERE revision_id=$1",[r.revisionId])).rejects.toThrow();
  await expect(db.query('DELETE FROM library_content_review_events WHERE revision_id=$1',[r.revisionId])).rejects.toThrow();
  await expect(db.query('TRUNCATE library_content_review_events')).rejects.toThrow();
 });
 it('requires meaningful request-changes feedback; owner can read it and create a new correction draft',async()=>{
  const r=await create();await submit(r).expect(200);
  for(const comment of [undefined,'','  ','!!','x'.repeat(1001)]) await decide(r,'request-changes',reviewer,{comment}).expect(400);
  const result=(await decide(r,'request-changes',reviewer,{comment:'  Clarify the answer choices.  '}).expect(200)).body;
  expect(result.status).toBe('changes_requested');
  expect(result.reviewEvents[1]).toMatchObject({decision:'changes_requested',comment:'Clarify the answer choices.',actorUserId:reviewer.id});
  expect((await get(`${root}/${r.contentId}`).expect(200)).body).toEqual(result);
  await get(`${root}/${r.contentId}`,other).expect(404);
  const draft=(await request(app).post(`${root}/${r.contentId}/revisions`).set('Authorization',owner.auth).send({baseRevisionId:r.revisionId}).expect(201)).body;
  await submit(draft).expect(200); await decide(draft).expect(200);
  expect((await get(`${root}/${r.contentId}/revisions/${r.revisionId}`).expect(200)).body.reviewEvents).toEqual(result.reviewEvents);
 });
 it('dual-role Creator/Admin cannot review own submission by user identity',async()=>{
  const dual=await actor(['creator','admin']),r=await create(dual);
  await submit(r,dual).expect(200);
  await decide(r,'approve',dual).expect(403);
  await decide(r,'request-changes',dual,{comment:'My own feedback'}).expect(403);
  await decide(r).expect(200);
 });
 it('concurrent decisions produce one winning event and one conflict',async()=>{
  const r=await create();await submit(r).expect(200);
  const second=await actor(['admin']);
  const results=await Promise.all([decide(r),decide(r,'request-changes',second,{comment:'Please clarify instructions'})]);
  expect(results.map(x=>x.status).sort()).toEqual([200,409]);
  const events=(await db.query("SELECT * FROM library_content_review_events WHERE revision_id=$1 AND decision<>'submitted'",[r.revisionId])).rows;
  expect(events).toHaveLength(1);
  expect((await get(`${root}/${r.contentId}`).expect(200)).body.status).toBe(events[0].decision);
 });
 it('rejects stale draft submissions and obsolete submissions even if legacy SQL advanced the head',async()=>{
  const r=await create();
  const newer=(await request(app).put(`${root}/${r.contentId}`).set('Authorization',owner.auth).send({exercise:r.exercise,category:'Science',baseRevisionId:r.revisionId}).expect(200)).body;
  await submit(r).expect(409);await submit(newer).expect(200);
  // Privileged fixture models a pre-existing obsolete submission, bypassing only
  // the head guard. Supported API and ordinary SQL cannot create this situation.
  const c=await db.connect();
  try {
   await c.query('BEGIN');
   await c.query('ALTER TABLE library_content DISABLE TRIGGER library_identity_immutable');
   await c.query(`INSERT INTO library_content_revisions(content_id,version,exercise,category,geographic_scope)
    VALUES ($1,3,$2,'Science','universal')`,[r.contentId,r.exercise]);
   await c.query('UPDATE library_content SET head_version=3 WHERE id=$1',[r.contentId]);
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');
   await c.query('ALTER TABLE library_content ENABLE TRIGGER library_identity_immutable');await c.query('COMMIT');
  } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();}
  await decide(newer).expect(409);await detail(newer).expect(404);
 });
 it('ordinary SQL cannot set lifecycle status, forge review roles, mutate audit or bypass using a GUC',async()=>{
  const r=await create(),role='content_guard_'+randomUUID().replaceAll('-','');
  await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  const c=await db.connect();
  try {
   await c.query(`GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT,INSERT,UPDATE,DELETE ON library_content,library_content_revisions,library_content_review_events TO "${role}";
    GRANT SELECT ON users,user_roles TO "${role}"`);
   await c.query(`SET ROLE "${role}"`);
   await c.query("SELECT set_config('app.content_review','true',false)");
   await expect(c.query("UPDATE library_content_revisions SET status='submitted' WHERE id=$1",[r.revisionId])).rejects.toThrow();
   await expect(c.query("UPDATE library_content_revisions SET status='approved' WHERE id=$1",[r.revisionId])).rejects.toThrow();
   await expect(c.query(`INSERT INTO library_content_review_events(content_id,revision_id,actor_user_id,decision) VALUES ($1,$2,$3,'submitted')`,[r.contentId,r.revisionId,other.id])).rejects.toThrow();
   await c.query(`INSERT INTO library_content_review_events(content_id,revision_id,actor_user_id,decision) VALUES ($1,$2,$3,'submitted')`,[r.contentId,r.revisionId,owner.id]);
   await expect(c.query(`INSERT INTO library_content_review_events(content_id,revision_id,actor_user_id,decision) VALUES ($1,$2,$3,'approved')`,[r.contentId,r.revisionId,owner.id])).rejects.toThrow();
   await c.query(`INSERT INTO library_content_review_events(content_id,revision_id,actor_user_id,decision) VALUES ($1,$2,$3,'approved')`,[r.contentId,r.revisionId,reviewer.id]);
   await expect(c.query('DELETE FROM library_content_review_events WHERE revision_id=$1',[r.revisionId])).rejects.toThrow();
   await expect(c.query("UPDATE library_content_revisions SET status='draft' WHERE id=$1",[r.revisionId])).rejects.toThrow();
   await expect(c.query(`INSERT INTO library_content_revisions(content_id,version,status,exercise,geographic_scope) VALUES ($1,2,'approved',$2,'universal')`,[r.contentId,r.exercise])).rejects.toThrow();
  } finally {
   await c.query('RESET ROLE');await c.query(`DROP OWNED BY "${role}"`);c.release();await admin.query(`DROP ROLE "${role}"`);
  }
 });
 it('Content review leaves all Template and Hunt records unchanged',async()=>{
  const organization=(await db.query("INSERT INTO organizations(name,owner_id) VALUES ('Content boundary fixture',$1) RETURNING id",[owner.id])).rows[0].id;
  await db.query(`INSERT INTO hunts(organization_id,created_by_user_id,name,status,template_key,template_version,template_snapshot)
   VALUES ($1,$2,'Existing frozen snapshot','finished','signal-cluj-napoca',1,$3)`,
   [organization,owner.id,{key:'signal-cluj-napoca',version:1,frozen:'original snapshot'}]);
  const snapshot=async()=>({templates:(await db.query('SELECT to_jsonb(t) row FROM hunt_templates t ORDER BY id')).rows,
   versions:(await db.query('SELECT to_jsonb(t) row FROM hunt_template_versions t ORDER BY id')).rows,
   reviews:(await db.query('SELECT to_jsonb(t) row FROM hunt_template_reviews t ORDER BY to_jsonb(t)::text')).rows,
   hunts:(await db.query('SELECT to_jsonb(t) row FROM hunts t ORDER BY id')).rows});
  const before=await snapshot(),r=await create();await submit(r).expect(200);await decide(r).expect(200);
  expect(await snapshot()).toEqual(before);
 });
});
