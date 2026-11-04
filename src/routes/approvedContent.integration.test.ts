import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';
import { customTemplateFixture, exerciseFixtures } from '../test/customExercises.js';
import { allocateCustomExercises } from '../domain/customExercises.js';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `library_content_${randomUUID().replaceAll('-', '')}`;
const root = '/api/creator/content';
const approved = root+'/approved';
type Actor = { id: string; auth: string };
(testUrl ? describe : describe.skip)('Approved Library discovery against disposable PostgreSQL', () => {
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

 const draft=async(title:string,extra:any={},exercise=exerciseFixtures[0])=>(await post({exercise:{...exercise,title},category:'Science',...extra}).expect(201)).body;
 const submit=(r:any)=>request(app).post(`${root}/${r.contentId}/revisions/${r.revisionId}/submit`).set('Authorization',owner.auth).send({});
 const approve=(r:any)=>request(app).post(`/api/admin/content/review/${r.contentId}/revisions/${r.revisionId}/approve`).set('Authorization',reviewer.auth).send({});
 const publish=async(title:string,extra:any={},exercise=exerciseFixtures[0])=>{const r=await draft(title,extra,exercise);await submit(r).expect(200);await approve(r).expect(200);return r;};
 const detail=(r:any,who=other)=>get(`${approved}/${r.contentId}/revisions/${r.revisionId}`,who);
 const list=async(query:any={},who=other)=>(await get(approved,who).query(query).expect(200)).body;
 const clone=async(r:any)=>(await request(app).post(`${root}/${r.contentId}/revisions`).set('Authorization',owner.auth).send({baseRevisionId:r.revisionId}).expect(201)).body;
 const token=()=>randomUUID();

 it('shares only approval-backed revisions, independently of the head, and never substitutes exact IDs',async()=>{
  const q=token(),a=await publish(q),unreviewed=await draft(q),submitted=await draft(q),changes=await draft(q);
  await submit(submitted).expect(200);await submit(changes).expect(200);
  await request(app).post(`/api/admin/content/review/${changes.contentId}/revisions/${changes.revisionId}/request-changes`).set('Authorization',reviewer.auth).send({comment:'Clarify this question'}).expect(200);
  for(const r of [unreviewed,submitted,changes]) await detail(r).expect(404);
  expect((await list({q})).items.map((r:any)=>r.revisionId)).toEqual([a.revisionId]);
  const b=await clone(a);
  expect((await list({q})).items.map((r:any)=>r.revisionId)).toEqual([a.revisionId]);
  await detail(b).expect(404);await submit(b).expect(200);await approve(b).expect(200);
  expect((await list({q})).items.map((r:any)=>r.revisionId)).toEqual([b.revisionId]);
  expect((await detail(a).expect(200)).body.version).toBe(1);
  expect((await detail(b).expect(200)).body.version).toBe(2);
  await get(`${approved}/${a.contentId}/revisions/${submitted.revisionId}`,other).expect(404);
  // Selection precedes filtering: never fall back to a historical matching category.
  const c=await clone(b);
  const revised=(await request(app).put(`${root}/${c.contentId}`).set('Authorization',owner.auth).send({baseRevisionId:c.revisionId,exercise:c.exercise,category:'History'}).expect(200)).body;
  await submit(revised).expect(200);await approve(revised).expect(200);
  expect((await list({q,category:'Science'})).items).toEqual([]);
  expect((await detail(a).expect(200)).body.category).toBe('Science');
 });

 for(const exercise of exerciseFixtures) it(`discovers ${exercise.classification}/${exercise.type} and preserves complete canonical data and LaTeX`,async()=>{
  const q=token(),e={...exercise,instructions:'Compute $\\frac{1}{2}$\nă π ≥ 2  ',solution:'Solution: $x^2$\nexact whitespace  '};
  const r=await publish(q,{},e);
  const items=(await list({q,classification:e.classification,type:e.type})).items;
  expect(items).toHaveLength(1);expect(items[0]).toMatchObject({contentId:r.contentId,revisionId:r.revisionId,version:1,status:'approved',classification:e.classification,type:e.type});
  for(const key of ['exercise','answer','instructions','ownerId','reviewEvents']) expect(items[0]).not.toHaveProperty(key);
  const result=(await detail(r).expect(200)).body;
  expect(result.exercise).toEqual({...e,title:q});
  expect(result).not.toHaveProperty('ownerId');expect(result).not.toHaveProperty('reviewEvents');
  expect((await list({q,classification:e.classification==='personal'?'team':'personal'})).items).toEqual([]);
 });

 it('filters supported category and Mathematics grade; unspecified never means every grade',async()=>{
  const q=token();
  const five=await publish(q,{category:'Mathematics',curriculum:{subject:'math',grade:'5'}});
  const six=await publish(q,{category:'Mathematics',curriculum:{grade:'6'}});
  const unknown=await publish(q,{category:'Mathematics'});
  await publish(q,{category:'History'});
  expect((await list({q,grade:'5'})).items.map((r:any)=>r.contentId)).toEqual([five.contentId]);
  expect((await list({q,grade:'6'})).items.map((r:any)=>r.contentId)).toEqual([six.contentId]);
  expect((await list({q,category:'Mathematics',grade:'unspecified'})).items.map((r:any)=>r.contentId)).toEqual([unknown.contentId]);
  expect((await list({q,category:'History'})).items).toHaveLength(1);
  expect((await list({q,category:'Mathematics'})).items).toHaveLength(3);
 });

 it('searches title and instructions case-insensitively with literal wildcard characters',async()=>{
  const q=token();await publish(q+' MixedCASE');
  await publish('Instruction match',{exercise:{...exerciseFixtures[0],title:'Instruction match',instructions:q+' 100%_literal'}});
  expect((await list({q:q+' mixedcase'})).items).toHaveLength(1);
  expect((await list({q:q+' 100%_literal'})).items).toHaveLength(1);
  expect((await list({q:q+' 100ZZliteral'})).items).toHaveLength(0);
  expect((await list({q:'  '+q+'  '})).items).toHaveLength(2);
 });

 it('uses canonical inclusive country/region/city hierarchy and fails closed on unresolved location',async()=>{
  await db.query("INSERT INTO countries(code,display_name) VALUES ('RO','Romania'),('HU','Hungary') ON CONFLICT DO NOTHING");
  const imp=(await db.query(`INSERT INTO geographic_imports(source,dataset,sha256,attribution) VALUES ('geonames','c2d-fixture',$1,'GeoNames (CC BY 4.0)') RETURNING id`,['b'.repeat(64)])).rows[0].id;
  await db.query(`INSERT INTO geographic_regions(country_code,admin1_code,display_name,import_id) VALUES ('RO','13','Cluj',$1),('RO','10','Bucharest',$1),('HU','01','Budapest',$1) ON CONFLICT DO NOTHING`,[imp]);
  for(const [id,country,region] of [['681290','RO','13'],['683506','RO','10'],['664460','RO','13'],['3054643','HU','01'],['999001','RO','00']]) {
   await db.query(`INSERT INTO geographic_cities(geoname_id,country_code,name,administrative_context,admin1_code,admin2_code,latitude,longitude,population,source_modified,import_id)
    VALUES ($1,$2,'Ambiguous name','Catalog fixture',$3,'',46,23,1,'2026-01-01',$4) ON CONFLICT DO NOTHING`,[id,country,region,imp]);
  }
  const q=token(),ids:Record<string,string>={};
  for(const [label,geography] of Object.entries({universal:{scope:'universal'},ro:{scope:'country',countryCode:'RO'},hu:{scope:'country',countryCode:'HU'},
   cluj:{scope:'region',countryCode:'RO',admin1Code:'13'},bucharest:{scope:'region',countryCode:'RO',admin1Code:'10'},
   city:{scope:'city',countryCode:'RO',geographicId:'681290'},otherCity:{scope:'city',countryCode:'RO',geographicId:'683506'},
   nearby:{scope:'city',countryCode:'RO',geographicId:'664460'},foreign:{scope:'city',countryCode:'HU',geographicId:'3054643'}})) ids[label]=(await publish(q,{geography})).contentId;
  const matches=async(query:any)=>(await list({q,...query})).items.map((r:any)=>r.contentId).sort();
  expect(await matches({countryCode:'RO',geographicId:'681290'})).toEqual(['universal','ro','cluj','city'].map(k=>ids[k]).sort());
  expect(await matches({countryCode:'RO',admin1Code:'13'})).toEqual(['universal','ro','cluj'].map(k=>ids[k]).sort());
  expect(await matches({countryCode:'RO'})).toEqual(['universal','ro'].map(k=>ids[k]).sort());
  expect(await matches({countryCode:'HU',geographicId:'681290'})).toEqual(['universal','hu'].map(k=>ids[k]).sort());
  for(const query of [{countryCode:'RO',geographicId:'9999999'},{countryCode:'RO',geographicId:'999001'},{countryCode:'RO',admin1Code:'missing'}]) {
   expect(await matches(query)).toEqual(['universal','ro'].map(k=>ids[k]).sort());
  }
  expect(await matches({})).toHaveLength(9);
 });

 it('enforces authentication, guest/blocked restrictions and cross-Creator read-only boundaries',async()=>{
  const r=await publish(token()),path=`${approved}/${r.contentId}/revisions/${r.revisionId}`;
  for(const url of [approved,path]) {
   await request(app).get(url).expect(401);await get(url,participant).expect(403);await get(url,reviewer).expect(403);
   const guest=await actor(['creator']);await db.query('UPDATE users SET is_guest=true WHERE id=$1',[guest.id]);await get(url,guest).expect(403);
   const blocked=await actor(['creator']);await db.query("UPDATE users SET account_status='blocked' WHERE id=$1",[blocked.id]);await get(url,blocked).expect(401);
  }
  await detail(r).expect(200);
  await get(`${root}/${r.contentId}`,other).expect(404);
  await get(`${root}/${r.contentId}/revisions/${r.revisionId}`,other).expect(404);
  await request(app).put(`${root}/${r.contentId}`).set('Authorization',other.auth).send({baseRevisionId:r.revisionId,exercise:r.exercise}).expect(404);
  await request(app).post(`${root}/${r.contentId}/revisions`).set('Authorization',other.auth).send({baseRevisionId:r.revisionId}).expect(404);
  await request(app).post(`/api/admin/content/review/${r.contentId}/revisions/${r.revisionId}/approve`).set('Authorization',other.auth).send({}).expect(403);
  await request(app).put(path).set('Authorization',other.auth).send({status:'archived'}).expect(404);
 });

 it('bounds and validates all queries and rejects signed-token misuse and cursor tampering',async()=>{
  for(const query of [{limit:'0'},{limit:'101'},{limit:'1.5'},{limit:['1','2']},{after:'garbage'},{grade:'4'},{classification:'navigation'},
   {type:'unknown'},{classification:'team',type:'single-choice'},{category:'All'},{q:' '},{q:'a'.repeat(201)},
   {countryCode:'ro'},{admin1Code:'13'},{countryCode:'RO',geographicId:'0'},{countryCode:'RO',geographicId:'681290',admin1Code:'13'},{main:'invented'}]) {
   await get(approved,other).query(query).expect(400);
  }
  await get(approved,other).query({after:other.auth.slice(7)}).expect(400);
  const expired=signJwt({type:'approved_content_cursor',after:randomUUID(),snapshot:'1:2:',filters:{}},{expiresIn:-1});
  await get(approved,other).query({after:expired}).expect(400);
  const q=token();for(let i=0;i<2;i++)await publish(q);
  const page=await list({q,limit:1});expect(page.nextAfter).toBeTypeOf('string');
  await get(approved,other).query({q,after:page.nextAfter+'x'}).expect(400);
  await get(approved,other).query({after:page.nextAfter}).expect(400);
  await request(app).get(approved).set('Authorization','Bearer '+page.nextAfter).expect(401);
  await get(`${approved}/invalid/revisions/invalid`,other).expect(400);
 });

 it('keeps stable pages and revisions across new drafts, approvals and previously uncommitted approvals',async()=>{
  const q=token(),initial=[];
  for(let i=0;i<4;i++)initial.push(await publish(q));
  const late=await draft(q);await submit(late).expect(200);
  const c=await db.connect();
  try {
   await c.query('BEGIN');
   await c.query("INSERT INTO library_content_review_events(content_id,revision_id,actor_user_id,decision) VALUES ($1,$2,$3,'approved')",[late.contentId,late.revisionId,reviewer.id]);
   const first=await list({q,limit:1});expect(first.items).toHaveLength(1);
   await c.query('COMMIT');
   // Replace a not-yet-returned approved revision with a new approval.
   const remaining=initial.find(r=>r.contentId!==first.items[0].contentId)!;
   const newer=await clone(remaining);await submit(newer).expect(200);await approve(newer).expect(200);
   await publish(q);await clone(initial.find(r=>r.contentId!==remaining.contentId)!);
   const seen=[...first.items];let after=first.nextAfter;
   while(after){const page=await list({q,limit:1,after});seen.push(...page.items);after=page.nextAfter;}
   expect(seen.map(r=>r.contentId)).toEqual(initial.map(r=>r.contentId).sort());
   expect(seen.map(r=>r.revisionId).sort()).toEqual(initial.map(r=>r.revisionId).sort());
   expect((await list({q})).items).toHaveLength(6);
  } finally {await c.query('ROLLBACK');c.release();}
 });

 it('excludes forged approval status, archived revisions, and unsupported stored classification',async()=>{
  const q=token(),unreviewed=await draft(q),archived=await publish(q),unsupported=await publish(q);
  // Privileged corruption fixtures: supported APIs and ordinary SQL cannot do this.
  const c=await db.connect();
  try {
   await c.query('BEGIN');await c.query('ALTER TABLE library_content_revisions DISABLE TRIGGER library_revision_immutable');
   await c.query("UPDATE library_content_revisions SET status='approved' WHERE id=$1",[unreviewed.revisionId]);
   await c.query("UPDATE library_content_revisions SET status='archived' WHERE id=$1",[archived.revisionId]);
   await c.query(`UPDATE library_content_revisions SET exercise=jsonb_set(exercise,'{type}','"unsupported"') WHERE id=$1`,[unsupported.revisionId]);
   await c.query('ALTER TABLE library_content_revisions ENABLE TRIGGER library_revision_immutable');await c.query('COMMIT');
  } catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  expect((await list({q})).items).toEqual([]);
  for(const r of [unreviewed,archived,unsupported])await detail(r).expect(404);
 });

 it('all discovery reads leave Content, Template and Hunt snapshots unchanged',async()=>{
  const r=await publish(token());
  const organization=(await db.query("INSERT INTO organizations(name,owner_id) VALUES ('Discovery integrity fixture',$1) RETURNING id",[owner.id])).rows[0].id;
  const key='discovery-integrity-'+token();
  const template=(await db.query("INSERT INTO hunt_templates(key,origin,created_by_user_id,status) VALUES ($1,'creator',$2,'draft') RETURNING id",[key,owner.id])).rows[0].id;
  const content=allocateCustomExercises(customTemplateFixture(key),key,1);
  await db.query("INSERT INTO hunt_template_versions(template_id,version,content,origin,created_by_user_id) VALUES ($1,1,$2,'creator',$3)",[template,content,owner.id]);
  await db.query(`INSERT INTO hunts(organization_id,created_by_user_id,name,status,template_key,template_version,template_snapshot)
   VALUES ($1,$2,'Frozen Hunt','finished',$4,1,$3)`,[organization,owner.id,content,key]);
  const snapshot=async()=>{
   const result:Record<string,unknown>={};
   for(const table of ['library_content','library_content_revisions','library_content_review_events','hunt_templates','hunt_template_versions','hunt_template_reviews','hunts']) {
    result[table]=(await db.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
   }return result;
  };
  const before=await snapshot();await list();await detail(r).expect(200);
  expect(await snapshot()).toEqual(before);
 });
});
