import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';
import { customTemplateFixture, exerciseFixtures } from '../test/customExercises.js';

const testUrl=process.env.TEST_DATABASE_URL;
const databaseName=`allocation_${randomUUID().replaceAll('-','')}`;
const root='/api/creator/templates', library='/api/creator/content';
type Actor={id:string;auth:string};
(testUrl?describe:describe.skip)('Exact approved Library allocation in immutable Template versions',()=>{
 const admin=new Pool({connectionString:testUrl});
 let db:Pool,appPool:Pool,app:ReturnType<typeof import('../app.js').createApp>,created=false;
 let sign:typeof import('../lib/jwt.js').signJwt;
 let owner:Actor,other:Actor,reviewer:Actor,participant:Actor;
 let local:string,unknown:string;
 const actor=async(roles:string[]):Promise<Actor>=>{
  const id=(await db.query("INSERT INTO users(email,role) VALUES ($1,'participant') RETURNING id",[`${randomUUID()}@example.invalid`])).rows[0].id;
  for(const role of roles)await db.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)',[id,role]);
  return {id,auth:`Bearer ${sign({sub:id,type:'access'})}`};
 };
 const post=(path:string,body:object={},who=owner)=>request(app).post(path).set('Authorization',who.auth).send(body);
 const get=(path:string,who=owner)=>request(app).get(path).set('Authorization',who.auth);
 const source=async(e=exerciseFixtures[0],extra:object={},approve=true)=>{
  const r=(await post(library,{exercise:e,category:'Science',...extra},other).expect(201)).body;
  if(approve){await post(`${library}/${r.contentId}/revisions/${r.revisionId}/submit`,{},other).expect(200);
   await post(`/api/admin/content/review/${r.contentId}/revisions/${r.revisionId}/approve`,{},reviewer).expect(200);}
  return r;
 };
 const specific=(r:any)=>({mode:'specific',contentId:r.contentId,revisionId:r.revisionId});
 const random=(filters:object={})=>({mode:'random',filters});
 const content=(allocations:any[],key=`allocation-${randomUUID()}`)=>{
  const c=customTemplateFixture(key);c.configuration={normalCheckpointCount:Math.max(1,allocations.length-1),category:'Science'};
  c.checkpoints=allocations.map((a,i)=>({...i===allocations.length-1?{role:'terminal'}:{role:'normal',checkpoint:i+1},
   ...(a?{libraryAllocations:a}:{})}));return c;
 };
 const save=(c:any,extra:object={},who=owner)=>post(root,{key:c.key,category:'universal',content:c,...extra},who);
 const snapshot=async()=>({versions:(await db.query('SELECT to_jsonb(v) row FROM hunt_template_versions v ORDER BY id')).rows,
  templates:(await db.query('SELECT to_jsonb(t) row FROM hunt_templates t ORDER BY id')).rows,
  hunts:(await db.query('SELECT to_jsonb(h) row FROM hunts h ORDER BY id')).rows});
 beforeAll(async()=>{
  await admin.query(`CREATE DATABASE "${databaseName}"`);created=true;
  const url=new URL(testUrl!);url.pathname=`/${databaseName}`;db=new Pool({connectionString:url.toString()});
  const c=await db.connect();try{
   await c.query(await readFile(new URL('../db/pre_migration_baseline.sql',import.meta.url),'utf8'));
   const dir=new URL('../db/migrations/',import.meta.url),ms:Migration[]=[];
   for(const n of(await readdir(dir)).filter(n=>/^\d{3}_.*\.ts$/.test(n)).sort())ms.push((await import(new URL(n,dir).href)).default);
   expect(await runMigrations(c,ms)).toContain('045_template_content_allocation');expect(await runMigrations(c,ms)).toEqual([]);
  }finally{c.release();}
  (await import('../config/environment.js')).environment.databaseUrl=url.toString();
  appPool=(await import('../lib/postgres.js')).pool;app=(await import('../app.js')).createApp();sign=(await import('../lib/jwt.js')).signJwt;
  owner=await actor(['creator']);other=await actor(['creator']);reviewer=await actor(['admin']);participant=await actor(['participant']);
  local=(await db.query("INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provenance) VALUES ('RO','Allocation city','Test',46,23,'Test') RETURNING id")).rows[0].id;
  unknown=(await db.query("INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provenance) VALUES ('RO','Unknown mapping','Test',46,23,'Test') RETURNING id")).rows[0].id;
  const imp=(await db.query("INSERT INTO geographic_imports(source,dataset,sha256,attribution) VALUES ('geonames','allocation-test',$1,'GeoNames (CC BY 4.0)') RETURNING id",['c'.repeat(64)])).rows[0].id;
  await db.query("INSERT INTO geographic_regions(country_code,admin1_code,display_name,import_id) VALUES ('RO','ALLOC','Allocation region',$1),('RO','OTHER','Other region',$1)",[imp]);
  await db.query(`INSERT INTO geographic_cities(geoname_id,country_code,admin1_code,name,administrative_context,admin2_code,latitude,longitude,population,source_modified,import_id,locality_id)
   VALUES (990001,'RO','ALLOC','Allocation city','Test','',46,23,1,'2026-01-01',$2,$1),(990002,'RO','OTHER','Other city','Test','',46,23,1,'2026-01-01',$2,NULL)`,[local,imp]);
 },30000);
 afterAll(async()=>{app?.locals.stopAbuseProtection?.();await appPool?.end();await db?.end();if(created)await admin.query(`DROP DATABASE "${databaseName}"`);await admin.end();});

 it.each(exerciseFixtures.map(e=>[e.type,e]))('%s preserves every canonical mechanic, payload and approved identity',async(_type,e:any)=>{
  const r=await source(e),c=content([null,{[e.classification]:specific(r)}]);
  const saved=(await save(c).expect(201)).body;
  const cp=saved.content.checkpoints[1],{id,owner:binding,...payload}=cp.customExercises[e.classification];
  expect(payload).toEqual(e);expect(id).toBeTruthy();expect(binding).toEqual({templateKey:c.key,version:1});
  expect(cp.libraryAllocations[e.classification]).toMatchObject({...specific(r),version:r.version,classification:e.classification,type:e.type});
  expect(saved.status).toBe('draft');expect((await get(`${root}/${c.key}`).expect(200)).body.content).toEqual(saved.content);
 });
 it('rejects incorrect Content/Revision identity and rolls back both identity and version',async()=>{
  const r=await source(),c=content([{personal:{...specific(r),contentId:randomUUID()}},null]),before=await snapshot();
  expect((await save(c).expect(400)).body.error).toBe('incorrect_revision_identity');expect(await snapshot()).toEqual(before);
 });
 it.each(['draft','submitted','changes_requested'])('rejects %s revisions',async state=>{
  const r=await source(exerciseFixtures[0],{},false);
  if(state!=='draft')await post(`${library}/${r.contentId}/revisions/${r.revisionId}/submit`,{},other).expect(200);
  if(state==='changes_requested')await post(`/api/admin/content/review/${r.contentId}/revisions/${r.revisionId}/request-changes`,{comment:'Clarify the instructions'},reviewer).expect(200);
  expect((await save(content([{personal:specific(r)},null])).expect(400)).body.error).toBe('unapproved_revision');
 });
 it('retains old approvals across new drafts/approvals and never mutates saved Templates or Hunt snapshots',async()=>{
  const r=await source(),saved=(await save(content([{personal:specific(r)},null])).expect(201)).body;
  const org=(await db.query("INSERT INTO organizations(name,owner_id) VALUES ('Allocation snapshot',$1) RETURNING id",[owner.id])).rows[0].id;
  await db.query("INSERT INTO hunts(organization_id,created_by_user_id,name,status,template_snapshot) VALUES ($1,$2,'Frozen','finished',$3)",[org,owner.id,saved.content]);
  const before=await snapshot();
  const draft=(await post(`${library}/${r.contentId}/revisions`,{baseRevisionId:r.revisionId},other).expect(201)).body;
  await save(content([{personal:specific(r)},null])).expect(201);
  const afterOld=await snapshot();
  await post(`${library}/${r.contentId}/revisions/${draft.revisionId}/submit`,{},other).expect(200);
  await post(`/api/admin/content/review/${r.contentId}/revisions/${draft.revisionId}/approve`,{},reviewer).expect(200);
  expect(await snapshot()).toEqual(afterOld);
  expect((await get(`${root}/${saved.key}`).expect(200)).body.content).toEqual(saved.content);
  expect((await snapshot()).hunts).toEqual(before.hunts);
 });
 it('enforces Personal/Team classification in both directions',async()=>{
  for(const [e,slot] of [[exerciseFixtures[0],'team'],[exerciseFixtures[15],'personal']] as const){
   const r=await source(e);expect((await save(content([{[slot]:specific(r)},null])).expect(400)).body.error).toBe('allocation_classification_mismatch');
  }
 });
 it('rejects duplicate Personal Content across checkpoints, FinishPoint and different approved revisions',async()=>{
  const r=await source();const draft=(await post(`${library}/${r.contentId}/revisions`,{baseRevisionId:r.revisionId},other).expect(201)).body;
  await post(`${library}/${r.contentId}/revisions/${draft.revisionId}/submit`,{},other).expect(200);
  await post(`/api/admin/content/review/${r.contentId}/revisions/${draft.revisionId}/approve`,{},reviewer).expect(200);
  expect((await save(content([{personal:specific(r)},{personal:specific(draft)}])).expect(400)).body.error).toBe('duplicate_personal_exercise');
  const team=await source(exerciseFixtures[15]);await save(content([{team:specific(team)},{team:specific(team)}])).expect(201);
 });
 it('Random uses only eligible latest approvals and persists once across reads and echoed version saves',async()=>{
  const e={...exerciseFixtures[4],title:'Random approved'},r=await source(e,{category:'History'});
  await source(e,{category:'History'},false);
  const c=content([{personal:random({type:e.type})},null]);c.configuration.category='History';
  const saved=(await save(c).expect(201)).body;
  expect(saved.content.checkpoints[0].libraryAllocations.personal.revisionId).toBe(r.revisionId);
  for(let i=0;i<3;i++)expect((await get(`${root}/${c.key}`).expect(200)).body.content).toEqual(saved.content);
  const next={...saved.content,version:2};const version=(await post(`${root}/${c.key}/versions`,{content:next}).expect(201)).body;
  expect(version.content.checkpoints[0].libraryAllocations).toEqual(saved.content.checkpoints[0].libraryAllocations);
  expect(version.content.checkpoints[0].customExercises.personal.owner.version).toBe(2);
 });
 it('empty pools and insufficient distinct pools fail atomically with actionable errors',async()=>{
  const c=content([{personal:random({type:'shape-pattern'})},null]);c.configuration.category='History';
  expect((await save(c).expect(400)).body.error).toBe('empty_random_pool');
  await source(exerciseFixtures[13],{category:'History'});
  const d=content([{personal:random({type:'shape-pattern'})},{personal:random({type:'shape-pattern'})}]);d.configuration.category='History';
  const before=await snapshot();expect((await save(d).expect(400)).body.error).toBe('insufficient_distinct_exercises');expect(await snapshot()).toEqual(before);
 });
 it('Specific reserves Personal identity before Random and overlapping pools use distinct matches',async()=>{
  const a=await source(exerciseFixtures[8],{category:'Mixed'}),b=await source(exerciseFixtures[9],{category:'Mixed'});
  const c=content([{personal:random()},{personal:specific(a)}]);c.configuration.category='Mixed';
  const saved=(await save(c).expect(201)).body.content;
  expect(saved.checkpoints[0].libraryAllocations.personal.contentId).toBe(b.contentId);
  const d=content([{personal:random()},{personal:random({type:'fill-blank'})}]);d.configuration.category='Mixed';
  const matched=(await save(d).expect(201)).body.content;
  expect(matched.checkpoints.map((cp:any)=>cp.libraryAllocations.personal.contentId)).toEqual([b.contentId,a.contentId]);
 });
 it('checks actual category and explicit grade; unspecified grades never satisfy a specific grade',async()=>{
  const r=await source(exerciseFixtures[0],{category:'Mathematics'});
  expect((await save(content([{personal:specific(r)},null])).expect(400)).body.error).toBe('allocation_category_mismatch');
  const c=content([{personal:specific(r)},null]);c.configuration={...c.configuration,category:'Mathematics',curriculum:'math',grade:'9'};
  expect((await save(c).expect(400)).body.error).toBe('allocation_grade_mismatch');
  const grade=await source(exerciseFixtures[0],{category:'Mathematics',curriculum:{grade:'9'}});c.checkpoints[0].libraryAllocations.personal=specific(grade);
  await save(c).expect(201);c.configuration.grade='10';expect((await save({...c,key:`grade-${randomUUID()}`}).expect(400)).body.error).toBe('allocation_grade_mismatch');
 });
 it.each([
  [{scope:'universal'},true], [{scope:'country',countryCode:'RO'},true],
  [{scope:'region',countryCode:'RO',admin1Code:'ALLOC'},true], [{scope:'city',countryCode:'RO',geographicId:'990001'},true],
  [{scope:'region',countryCode:'RO',admin1Code:'OTHER'},false], [{scope:'city',countryCode:'RO',geographicId:'990002'},false],
 ])('uses canonical locality hierarchy for %j',async(geography,eligible)=>{
  const r=await source(exerciseFixtures[0],{geography});const c=content([{personal:specific(r)},null]);
  const res=await save(c,{category:'local',localityId:local}).expect(eligible?201:400);
  if(!eligible)expect(res.body.error).toBe('allocation_geography_mismatch');
  if(geography.scope!=='universal')expect((await save(content([{personal:specific(r)},null])).expect(400)).body.error).toBe('allocation_geography_mismatch');
 });
 it('unknown locality mapping cannot match a city/region by name or coordinates',async()=>{
  const r=await source(exerciseFixtures[0],{geography:{scope:'city',countryCode:'RO',geographicId:'990001'}});
  expect((await save(content([{personal:specific(r)},null]),{category:'local',localityId:unknown}).expect(400)).body.error).toBe('allocation_geography_mismatch');
 });
 it('rejects invalid checkpoint assignment, conflicting own exercise and fabricated Random pins',async()=>{
  const r=await source(),c=content([{personal:specific(r)},null]);c.checkpoints[0].checkpoint=99;
  expect((await save(c).expect(400)).body.error).toBe('invalid_checkpoint_assignment');
  c.checkpoints[0].checkpoint=1;c.checkpoints[0].customExercises={personal:exerciseFixtures[0]};
  expect((await save(c).expect(400)).body.error).toBe('allocation_slot_conflict');delete c.checkpoints[0].customExercises;
  c.checkpoints[0].libraryAllocations.personal={...specific(r),mode:'random'};
  expect((await save(c).expect(400)).body.error).toBe('invalid_allocation');
  c.checkpoints[0].libraryAllocations.personal={mode:'random',type:'single-choice'};
  expect((await save(c).expect(400)).body.error).toBe('invalid_allocation');
 });
 it('authorizes Creator ownership; allocation never approves a Template',async()=>{
  const r=await source(),c=content([{personal:specific(r)},null]);await save(c,{},participant).expect(403);
  const saved=(await save(c).expect(201)).body;
  await post(`${root}/${c.key}/versions`,{content:{...saved.content,version:2}},other).expect(404);
  await get(`${root}/${c.key}`,other).expect(404);
  await post(`/api/admin/templates/review/${c.key}/approve`,{version:1},reviewer).expect(409);
  await post(`${root}/${c.key}/submit`,{version:1}).expect(200);
  await post(`/api/admin/templates/review/${c.key}/approve`,{version:1},reviewer).expect(200);
 });
 it('concurrent saves serialize version identity and capture one consistent approved revision per assignment',async()=>{
  const r=await source(exerciseFixtures[10],{category:'History'}),c=content([{personal:random({type:r.exercise.type})},null]);c.configuration.category='History';
  const saved=(await save(c).expect(201)).body;
  const draft=(await post(`${library}/${r.contentId}/revisions`,{baseRevisionId:r.revisionId},other).expect(201)).body;
  await post(`${library}/${r.contentId}/revisions/${draft.revisionId}/submit`,{},other).expect(200);
  const next=structuredClone(c);next.version=2;
  const responses=await Promise.all([post(`${root}/${c.key}/versions`,{content:next}),post(`${root}/${c.key}/versions`,{content:next}),
   post(`/api/admin/content/review/${r.contentId}/revisions/${draft.revisionId}/approve`,{},reviewer)]);
  expect(responses.slice(0,2).map(r=>r.status).sort()).toEqual([201,400]);expect(responses[2].status).toBe(200);
  const final=(await get(`${root}/${c.key}`).expect(200)).body;
  expect([r.revisionId,draft.revisionId]).toContain(final.content.checkpoints[0].libraryAllocations.personal.revisionId);
  expect(final.content.checkpoints[0].customExercises.personal.owner.version).toBe(2);
  expect((await db.query('SELECT content FROM hunt_template_versions v JOIN hunt_templates t ON t.id=v.template_id WHERE t.key=$1 AND v.version=1',[c.key])).rows[0].content).toEqual(saved.content);
 });
 it('database rejects forged identity/payload and allocated snapshots cannot be updated',async()=>{
  const r=await source(),saved=(await save(content([{personal:specific(r)},null])).expect(201)).body;
  await expect(db.query("UPDATE hunt_template_versions v SET content=content||'{\"tampered\":true}'::jsonb FROM hunt_templates t WHERE t.id=v.template_id AND t.key=$1",[saved.key])).rejects.toMatchObject({code:'23514'});
  const forged=structuredClone(saved.content);forged.version=2;const e=forged.checkpoints[0].customExercises.personal;e.owner.version=2;e.id=randomUUID();e.title='forged';
  await expect(db.query("INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id) SELECT id,2,$2,'creator','universal',created_by_user_id FROM hunt_templates WHERE key=$1",[saved.key,forged])).rejects.toMatchObject({code:'23514'});
 });
 it('failed allocation leaves an existing version and draft status intact',async()=>{
  const r=await source(),saved=(await save(content([{personal:specific(r)},null])).expect(201)).body;
  const next=structuredClone(saved.content);next.version=2;
  delete next.checkpoints[0].customExercises;
  next.checkpoints[0].libraryAllocations.personal={...specific(r),revisionId:randomUUID()};
  const before=await snapshot();expect((await post(`${root}/${saved.key}/versions`,{content:next}).expect(400)).body.error).toBe('incorrect_revision_identity');
  expect(await snapshot()).toEqual(before);
 });
 it('Random excludes geography mismatches and rejects stale Specific metadata and modified frozen payloads',async()=>{
  const r=await source(exerciseFixtures[12],{category:'History',geography:{scope:'city',countryCode:'RO',geographicId:'990001'}});
  await source(exerciseFixtures[12],{category:'History',geography:{scope:'city',countryCode:'RO',geographicId:'990002'}});
  const c=content([{personal:random({type:'number-pattern'})},null]);c.configuration.category='History';
  const saved=(await save(c,{category:'local',localityId:local}).expect(201)).body;
  expect(saved.content.checkpoints[0].libraryAllocations.personal.revisionId).toBe(r.revisionId);
  const next=structuredClone(saved.content);next.version=2;next.checkpoints[0].customExercises.personal.title='Changed';
  expect((await post(`${root}/${c.key}/versions`,{content:next}).expect(400)).body.error).toBe('allocated_payload_mismatch');
  const stale=content([{personal:{...specific(r),version:99}},null]);stale.configuration.category='History';
  expect((await save(stale,{category:'local',localityId:local}).expect(400)).body.error).toBe('incorrect_revision_identity');
 });
 it('Random never falls back to an older matching approval when the latest approved category differs',async()=>{
  const r=await source(exerciseFixtures[6],{category:'History'});
  const draft=(await post(`${library}/${r.contentId}/revisions`,{baseRevisionId:r.revisionId},other).expect(201)).body;
  const revised=(await request(app).put(`${library}/${r.contentId}`).set('Authorization',other.auth)
   .send({baseRevisionId:draft.revisionId,exercise:draft.exercise,category:'Science'}).expect(200)).body;
  await post(`${library}/${r.contentId}/revisions/${revised.revisionId}/submit`,{},other).expect(200);
  await post(`/api/admin/content/review/${r.contentId}/revisions/${revised.revisionId}/approve`,{},reviewer).expect(200);
  const c=content([{personal:random({type:'match-columns'})},null]);c.configuration.category='History';
  expect((await save(c).expect(400)).body.error).toBe('empty_random_pool');
  c.checkpoints[0].libraryAllocations.personal=specific(r);await save(c).expect(201);
 });
 it('published Universal copies retain Random identity and frozen payload without reallocation',async()=>{
  await source(exerciseFixtures[14],{category:'Mixed'});
  const c=content([{personal:random({type:'rule-discovery'})},null]);c.configuration.category='Mixed';
  const saved=(await save(c).expect(201)).body;
  await post(`${root}/${c.key}/submit`,{version:1}).expect(200);
  await post(`/api/admin/templates/review/${c.key}/approve`,{version:1},reviewer).expect(200);
  const id=(await db.query('SELECT id FROM hunt_templates WHERE key=$1',[c.key])).rows[0].id;
  const key=`copied-allocation-${randomUUID()}`;
  const copy=(await post(`${root}/from-universal/${c.key}`,{key,publishedReference:{templateId:id,version:1}}).expect(201)).body;
  const cp=copy.content.checkpoints[0],sourceCp=saved.content.checkpoints[0];
  expect(cp.libraryAllocations).toEqual(sourceCp.libraryAllocations);
  const {id:copyId,owner:copyOwner,...data}=cp.customExercises.personal;
  const {id:sourceId,owner:sourceOwner,...sourceData}=sourceCp.customExercises.personal;
  expect(copyId).not.toBe(sourceId);expect(copyOwner).toEqual({templateKey:key,version:1});expect(data).toEqual(sourceData);
 });
 it('excludes another country and allows only Universal/Country with an unmapped locality',async()=>{
  await db.query("INSERT INTO countries(code,display_name) VALUES ('HU','Hungary') ON CONFLICT DO NOTHING");
  const foreign=await source(exerciseFixtures[0],{geography:{scope:'country',countryCode:'HU'}});
  expect((await save(content([{personal:specific(foreign)},null]),{category:'local',localityId:local}).expect(400)).body.error).toBe('allocation_geography_mismatch');
  const national=await source(exerciseFixtures[0],{geography:{scope:'country',countryCode:'RO'}});
  await save(content([{personal:specific(national)},null]),{category:'local',localityId:unknown}).expect(201);
  const universal=await source();await save(content([{personal:specific(universal)},null]),{category:'local',localityId:unknown}).expect(201);
 });
});
