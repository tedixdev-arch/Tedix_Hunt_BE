import { randomUUID } from 'node:crypto';
import { readFile, readdir, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { importCities, readGeonames, type CityImport } from '../scripts/importGeonames.js';
import catalogMigration from '../db/migrations/032_geographic_catalog.js';
import completionMigration from '../db/migrations/033_geographic_import_completion.js';
import { signalClujNapocaV1 } from '../domain/templates/signalClujNapocaV1.js';
const suite=process.env.TEST_DATABASE_URL?describe:describe.skip;
const city=(id: string,name='Cluj-Napoca',extra: Partial<CityImport>={}): CityImport=>({id,country:'RO',countryName:'Romania',name,
 aliases:['Kolozsvár','Klausenburg'],context:'Cluj County',admin1:'13',admin2:'54975',latitude:46.7667,longitude:23.6,population:300000,modified:'2026-10-01',...extra});
const provenance={dataset:'synthetic test fixture; not a production source',sha256:'a'.repeat(64)};
suite('GeoNames catalog against real PostgreSQL',()=>{
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 const dbName=`geo_${randomUUID().replaceAll('-','')}`;
 let db: Pool,appPool: Pool,app: ReturnType<typeof import('../app.js').createApp>, sign: typeof import('../lib/jwt.js').signJwt;
 const users: Record<string,string>={}; let canonical: string;
 const auth=(who='creator')=>`Bearer ${sign({sub:users[who],type:'access'})}`;
 const get=(path: string,who='creator')=>request(app).get(path).set('Authorization',auth(who));
 const post=(path: string,body: object={},who='creator')=>request(app).post(path).set('Authorization',auth(who)).send(body);
 const search=(q: string,extra='')=>get(`/api/geography/cities?countryCode=RO&q=${encodeURIComponent(q)}${extra}`);
 const ingest=async(rows: CityImport[])=>{const c=await db.connect();try{await c.query('BEGIN');const result=await importCities(c,rows,provenance);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const history=async()=>{const r: Record<string,any>={};for(const t of ['hunt_templates','hunt_template_versions','hunt_template_reviews','hunts'])r[t]=(await db.query(`SELECT * FROM ${t} ORDER BY 1,2`)).rows;return r;};
 beforeAll(async()=>{
  await admin.query(`CREATE DATABASE "${dbName}"`);const u=new URL(process.env.TEST_DATABASE_URL!);u.pathname=`/${dbName}`;
  db=new Pool({connectionString:u.toString()}); const c=await db.connect();
  try{
   await c.query(await readFile(new URL('../db/pre_migration_baseline.sql',import.meta.url),'utf8'));
   const dir=new URL('../db/migrations/',import.meta.url);const migrations=[];
   for(const f of (await readdir(dir)).filter(f=>/^\d{3}_.*\.ts$/.test(f)&&f<'032').sort())migrations.push((await import(new URL(f,dir).href)).default);
   await runMigrations(c,migrations);
   const before=await history();await catalogMigration.up(c);await completionMigration.up(c);expect(await history()).toEqual(before);
  }finally{c.release();}
  for(const role of ['creator','admin','organizer','participant','blocked','guest','revoked']){
   users[role]=(await db.query("INSERT INTO users(email,role,account_status,is_guest) VALUES($1,'participant',$2,$3) RETURNING id",[`${role}@geo.invalid`,role==='blocked'?'blocked':'active',role==='guest'])).rows[0].id;
   if(role!=='revoked')await db.query('INSERT INTO user_roles(user_id,role) VALUES($1,$2)',[users[role],['creator','admin','organizer'].includes(role)?role:role==='guest'?'creator':'participant']);
  }
  canonical=(await db.query("INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provenance) VALUES('RO','Cluj-Napoca','Cluj County',46.7667,23.6,'independent canonical test fixture') RETURNING id")).rows[0].id;
  const environment=(await import('../config/environment.js')).environment;environment.databaseUrl=u.toString();appPool=(await import('../lib/postgres.js')).pool;
  app=(await import('../app.js')).createApp();sign=(await import('../lib/jwt.js')).signJwt;

 },30000);
 afterAll(async()=>{app?.locals.stopAbuseProtection();await appPool?.end();await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);await admin.end();});
 it('reports unavailable until a nonempty import commits successfully',async()=>{
  const unavailable={error:'catalog_not_imported',catalogStatus:'not_imported',nextAction:'import_catalog'};
  await get('/api/geography/catalog-status').expect(200,{source:'geonames',status:'not_imported',nextAction:'import_catalog'});
  await request(app).get('/api/geography/catalog-status').expect(401);
  await get('/api/geography/catalog-status','participant').expect(403);
  await search('cluj').expect(503,unavailable);
  await get('/api/geography/cities/681290').expect(503,unavailable);
  await post('/api/geography/cities/681290/resolve').expect(503,unavailable);
  await post('/api/geography/cities/681290/registration',{create:true,reason:'not imported'},'admin').expect(503,unavailable);
  const client=await db.connect();
  try {
   await client.query('BEGIN');
   await expect(importCities(client,[],provenance)).rejects.toThrow('Empty import');
   await client.query('ROLLBACK');
   await get('/api/geography/catalog-status').expect(200,{source:'geonames',status:'not_imported',nextAction:'import_catalog'});
   // An incomplete old manifest and even city rows cannot declare the catalog operational.
   await client.query('BEGIN');
   const run=await importCities(client,[city('999','Incomplete')],provenance);
   await client.query('UPDATE geographic_imports SET completed_at=NULL,row_count=NULL WHERE id=$1',[run.importId]);
   await client.query('COMMIT');
   await get('/api/geography/catalog-status').expect(200,{source:'geonames',status:'not_imported',nextAction:'import_catalog'});
   await client.query('DELETE FROM geographic_cities WHERE geoname_id=999');
   await client.query('BEGIN');
   await importCities(client,[city('681290'),city('100','Șimleu Silvaniei',{aliases:['Szilágysomlyó'],context:'Sălaj County'}),city('101','Springfield',{aliases:[],context:'Region One'}),city('102','Springfield',{aliases:[],context:'Region Two'}),city('103','Springfield',{country:'US',countryName:'United States',aliases:[],context:'Illinois'})],provenance);
   await get('/api/geography/catalog-status').expect(200,{source:'geonames',status:'not_imported',nextAction:'import_catalog'});
   await client.query('COMMIT');
   await get('/api/geography/catalog-status').expect(200,{source:'geonames',status:'ready',nextAction:null});
  } finally {await client.query('ROLLBACK');client.release();}
 });
 it('filters by country without depending on Local Templates',async()=>{
  expect((await search('spring').expect(200)).body.cities.map((c:any)=>c.geographicId)).toEqual(['101','102']);
  const r=await get('/api/geography/cities?countryCode=US&q=spring').expect(200);expect(r.body.cities).toHaveLength(1);expect(r.body.cities[0].hasApprovedLocalTemplate).toBe(false);
  expect((await get('/api/geography/countries').expect(200)).body.countries.some((c:any)=>c.code==='US')).toBe(true);
 });
 it('uses literal prefix autocomplete and returns center plus disambiguation',async()=>{
  const r=await search('cluj').expect(200);expect(r.body.cities[0]).toMatchObject({geographicId:'681290',name:'Cluj-Napoca',administrativeContext:'Cluj County',latitude:46.7667,longitude:23.6,localityId:null});
  expect((await search('luj').expect(200)).body.cities).toEqual([]);expect((await search('%_').expect(200)).body.cities).toEqual([]);
 });
 it('matches Unicode diacritics and alternate names',async()=>{
  expect((await search('simleu').expect(200)).body.cities[0].name).toBe('Șimleu Silvaniei');
  expect((await search('ȘIMLEU').expect(200)).body.cities[0].geographicId).toBe('100');
  expect((await search('kolozsvar').expect(200)).body.cities[0].geographicId).toBe('681290');
 });
 it('preserves distinct same-name regions and pages stable source IDs',async()=>{
  const a=await search('spring','&limit=1').expect(200);expect(a.body.nextAfter).toBe('101');
  const b=await search('spring',`&limit=1&after=${a.body.nextAfter}`).expect(200);expect(b.body.cities[0].administrativeContext).toBe('Region Two');expect(b.body.nextAfter).toBeNull();
 });
 it('imports idempotently and updates aliases without changing source IDs or registered UUIDs',async()=>{
  await ingest([city('681290')]);expect((await db.query('SELECT count(*) FROM geographic_cities WHERE geoname_id=681290')).rows[0].count).toBe('1');
  await post('/api/geography/cities/681290/resolve').expect(200);await ingest([city('681290','Cluj-Napoca',{aliases:['New Alias'],population:400000,modified:'2026-10-02'})]);
  expect((await get('/api/geography/cities/681290').expect(200)).body.localityId).toBe(canonical);
  expect((await search('new alias').expect(200)).body.cities[0].geographicId).toBe('681290');
  expect((await search('klausenburg').expect(200)).body.cities).toEqual([]);
  await ingest([city('681290')]);expect((await search('new alias').expect(200)).body.cities).toHaveLength(1);
  await expect(ingest([city('681290','Cluj-Napoca',{country:'US',countryName:'United States',modified:'2026-10-03'})])).rejects.toThrow('Mapped source country changed');
  expect((await get('/api/geography/cities/681290').expect(200)).body.countryCode).toBe('RO');
 });
 it('rolls back invalid import batches and provenance',async()=>{
  const before=(await db.query('SELECT count(*) FROM geographic_imports')).rows;
  await expect(ingest([city('200'),city('201','bad',{latitude:NaN})])).rejects.toThrow();
  expect((await db.query('SELECT count(*) FROM geographic_imports')).rows).toEqual(before);expect((await db.query('SELECT 1 FROM geographic_cities WHERE geoname_id=200')).rowCount).toBe(0);
 });
 it('bounds pages at 50 with no repeated cities when aliases both match',async()=>{
  await ingest(Array.from({length:55},(_,i)=>city(String(1000+i),`Bound ${i}`,{aliases:['Bound alternate']})));
  const r=await search('bound','&limit=50').expect(200);expect(r.body.cities).toHaveLength(50);expect(new Set(r.body.cities.map((c:any)=>c.geographicId)).size).toBe(50);
  expect((await search('bound',`&limit=50&after=${r.body.nextAfter}`).expect(200)).body.cities).toHaveLength(5);
 });
 it('rejects short, empty, malformed and extra parameters',async()=>{
  for(const qs of ['countryCode=RO&q=','countryCode=RO&q=a','countryCode=ro&q=cluj','countryCode=ZZ&q=cluj','countryCode=RO&q=cluj&limit=51','countryCode=RO&q=cluj&after=-1','countryCode=RO&q=cluj&after=9999999999999999','countryCode=RO&q=cluj&x=1','countryCode=RO&q=a&q=b'])await get(`/api/geography/cities?${qs}`).expect(400);
  await get('/api/geography/cities/abc').expect(400);await get('/api/geography/cities/999999').expect(404);
  await post('/api/geography/cities/101/resolve',{latitude:1}).expect(400);
 });
 it('authorizes persisted roles before city lookup and separates Admin writes',async()=>{
  await request(app).get('/api/geography/cities?countryCode=RO&q=cluj').expect(401);
  for(const role of ['participant','guest','revoked'])await get('/api/geography/cities?countryCode=RO&q=cluj',role).expect(403);
  await get('/api/geography/cities?countryCode=RO&q=cluj','blocked').expect(401);
  await post('/api/geography/cities/101/registration',{create:true,reason:'x'}).expect(403);
  await post('/api/geography/cities/101/resolve',{},'organizer').expect(403);
  await get('/api/geography/cities?countryCode=RO&q=cluj','organizer').expect(200);
  await post('/api/geography/cities/101/registration',{create:true,reason:'not admin'},'organizer').expect(403);
  const catalog=(await import('../models/GeographicCatalog.js')).GeographicCatalog;
  await expect(catalog.resolve('101',users.creator,{create:true,reason:'direct call'})).rejects.toMatchObject({code:'forbidden',status:403});
  await expect(catalog.resolve('101',users.organizer)).rejects.toMatchObject({code:'forbidden',status:403});
  await expect(catalog.resolve('101',users.revoked)).rejects.toMatchObject({code:'forbidden',status:403});
  await expect(catalog.resolve('101',users.blocked)).rejects.toMatchObject({code:'unauthorized',status:401});
 });
 it('keeps unregistered cities explicit and uses no Creator coordinate or evidence input',async()=>{
  expect((await post('/api/geography/cities/101/resolve').expect(200)).body).toMatchObject({localityId:null,registrationState:'registration_required',nextAction:'request_registration'});
  const r=await post('/api/geography/cities/101/registration',{create:true,reason:'Reviewed official catalog'},'admin').expect(200);
  expect(r.body.registrationState).toBe('registered');expect(r.body.hasApprovedLocalTemplate).toBe(false);
  const l=(await db.query('SELECT * FROM localities WHERE id=$1',[r.body.localityId])).rows[0];expect(l.provider_id).toBe('101');expect(l.provenance).toContain('CC BY 4.0');
 });
 it('keeps catalog registration separate from Creator binding and C7 approval authority',async()=>{
  const registered=(await get('/api/geography/cities/101').expect(200)).body;
  const list=await get(`/api/organizer/local-templates?countryCode=RO&localityId=${registered.localityId}`,'organizer').expect(200);
  expect(list.body.templates).toEqual([]);
  const key=`catalog-binding-${randomUUID()}`;
  const content={key,version:1,displayName:'Catalog draft',theme:'Explore',mission:{name:'Find'},scoring:{startingScore:100},configuration:{normalCheckpointCount:1},checkpoints:[{checkpoint:1},{role:'terminal',navigationMode:'none'}]};
  await post('/api/creator/templates',{key,content,category:'local',localityId:registered.geographicId}).expect(400);
  await db.query('UPDATE localities SET active=false WHERE id=$1',[registered.localityId]);
  const r=await post('/api/geography/cities/101/resolve').expect(200);
  expect(r.body).toMatchObject({registrationState:'registered_inactive',nextAction:'contact_admin',hasApprovedLocalTemplate:false});
  await post('/api/creator/templates',{key,content,category:'local',localityId:registered.localityId}).expect(409);
  await db.query('UPDATE localities SET active=true WHERE id=$1',[registered.localityId]);
  await post('/api/creator/templates',{key,content,category:'local',localityId:registered.localityId}).expect(201);
  await post('/api/creator/templates',{key:`admin-${key}`,content:{...content,key:`admin-${key}`},category:'local',localityId:registered.localityId},'admin').expect(403);
  await post(`/api/admin/templates/review/${key}/approve`,{version:1},'creator').expect(403);
  expect((await get('/api/geography/cities/101').expect(200)).body.hasApprovedLocalTemplate).toBe(false);
 });
 it('preserves Cluj canonical UUID without competing records or Signal changes',async()=>{
  const before=await history();const r=await post('/api/geography/cities/681290/resolve').expect(200);
  expect(r.body.localityId).toBe(canonical);expect((await db.query("SELECT id FROM localities WHERE name='Cluj-Napoca'")).rows).toEqual([{id:canonical}]);expect(await history()).toEqual(before);
  expect(signalClujNapocaV1.key).toContain('cluj');
 });
 it('requires explicit reconciliation for ambiguous names and never silently creates duplicates',async()=>{
  await ingest([city('300','Ambiguous',{aliases:[]})]);
  for(const context of ['Region A','Region B'])await db.query("INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provenance) VALUES('RO','Ambiguous',$1,46,23,'test')",[context]);
  expect((await post('/api/geography/cities/300/resolve').expect(200)).body.registrationState).toBe('reconciliation_required');
  await post('/api/geography/cities/300/registration',{create:true,reason:'No guess'},'admin').expect(409);
  const id=(await db.query("SELECT id FROM localities WHERE name='Ambiguous' ORDER BY id LIMIT 1")).rows[0].id;
  expect((await post('/api/geography/cities/300/registration',{localityId:id,reason:'Identity confirmed independently'},'admin').expect(200)).body.localityId).toBe(id);
 });
 it('blocks punctuation variants from duplicate creation',async()=>{
  await ingest([city('301','Cluj Napoca',{aliases:[]})]);
  await post('/api/geography/cities/301/registration',{create:true,reason:'duplicate candidate'},'admin').expect(409);
 });
 it('serializes concurrent registration to one canonical identity',async()=>{
  await ingest([city('302','Race City',{aliases:[]})]);
  const r=await Promise.all([post('/api/geography/cities/302/registration',{create:true,reason:'one'},'admin'),post('/api/geography/cities/302/registration',{create:true,reason:'two'},'admin')]);
  expect(r.map(x=>x.status).sort()).toEqual([200,409]);expect((await db.query("SELECT count(*) FROM localities WHERE provider='geonames' AND provider_id='302'")).rows[0].count).toBe('1');
  await expect(db.query("UPDATE geographic_cities SET reconciliation_reason=NULL WHERE geoname_id=302")).rejects.toMatchObject({code:'23514'});
 });
 it('preserves approval and Organizer eligibility and historical Hunt snapshots across imports',async()=>{
  const content={key:'catalog-approved',version:1,displayName:'Catalog route',theme:'Explore',mission:{name:'Find'},scoring:{startingScore:100},configuration:{normalCheckpointCount:1,checkpointPositions:[{checkpointNumber:1,name:'Start',latitude:46.7667,longitude:23.6,radiusMeters:25}],finishPoint:{name:'Finish',latitude:46.7667,longitude:23.6,radiusMeters:25}},checkpoints:[{checkpoint:1},{role:'terminal',navigationMode:'none'}]};
  const template=(await db.query("INSERT INTO hunt_templates(key,origin,category,created_by_user_id,status) VALUES($1,'creator','local',$2,'draft') RETURNING id",[content.key,users.creator])).rows[0].id;
  const snap={id:canonical,countryCode:'RO',countryDisplayName:'Romania',name:'Cluj-Napoca',administrativeContext:'Cluj County',latitude:46.7667,longitude:23.6};
  await db.query("INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot) VALUES($1,1,$2,'creator','local',$3,$4,$5)",[template,content,users.creator,canonical,snap]);
  // Public approval is produced through the real existing review flow; no synthetic evidence.
  await post(`/api/creator/templates/${content.key}/submit`,{version:1}).expect(200);
  await post(`/api/admin/templates/review/${content.key}/approve`,{version:1,decision:'approved',notes:'Independent review'},'admin').expect(200);
  const org=(await db.query("INSERT INTO organizations(name,owner_id) VALUES('Catalog history',$1) RETURNING id",[users.organizer])).rows[0].id;
  await db.query("INSERT INTO hunts(organization_id,created_by_user_id,name,status,template_key,template_version,template_snapshot) VALUES($1,$2,'History','finished',$3,1,$4)",[org,users.organizer,signalClujNapocaV1.key,signalClujNapocaV1]);
  const hunt=(await post('/api/hunts',{organizationId:org,name:'Pinned catalog Hunt'},'organizer').expect(201)).body.id;
  await request(app).put(`/api/hunts/${hunt}/local-template`).set('Authorization',auth('organizer')).send({templateId:template,version:1,countryCode:'RO',localityId:canonical}).expect(200);
  const before=await history();await ingest([city('681290','Cluj-Napoca',{modified:'2026-10-03',aliases:['Cluj']})]);
  expect(await history()).toEqual(before);
  const r=await get('/api/geography/cities/681290').expect(200);expect(r.body.hasApprovedLocalTemplate).toBe(true);
  expect(JSON.stringify(r.body)).not.toMatch(/reviewer|notes|content|answer|suspension|created_by/);
  const eligible=await get(`/api/organizer/local-templates?countryCode=RO&localityId=${canonical}`,'organizer').expect(200);expect(eligible.body.templates.some((t:any)=>t.templateId===template)).toBe(true);
 });
 it('parses official TSV metadata and imports through the same PostgreSQL interface',async()=>{
  await mkdir('work', {recursive:true});
  const dir=await mkdtemp('work/geonames-');
  try {
   const files=['cities500.txt','countryInfo.txt','admin1CodesASCII.txt','admin2Codes.txt'].map(f=>`${dir}/${f}`);
   await writeFile(files[0],['900','Test Town','Test Town','Tést Alias','46','23','P','PPL','RO','','13','54975','','','1234','','','Europe/Bucharest','2026-10-01'].join('\t')+'\n');
   await writeFile(files[1],'# source comment\nRO\tROU\t642\tRO\tRomania\n');await writeFile(files[2],'RO.13\tCluj County\tCluj County\t1\n');await writeFile(files[3],'RO.13.54975\tMunicipality\tMunicipality\t2\n');
   const rows=[];for await(const row of readGeonames(files[0],files[1],files[2],files[3]))rows.push(row);
   expect(rows[0].context).toBe('Municipality, Cluj County');await ingest(rows);
   expect((await search('test alias').expect(200)).body.cities[0].geographicId).toBe('900');
   await writeFile(files[2],'');
   await expect((async()=>{for await(const row of readGeonames(files[0],files[1],files[2],files[3]))void row;})()).rejects.toThrow('Missing administrative metadata');
  } finally {await rm(dir,{recursive:true,force:true});}
 });
 it('uses the prefix index and enforces bounded authenticated query budgets',async()=>{
  await db.query('SET enable_seqscan=off');const plan=(await db.query("EXPLAIN SELECT geoname_id FROM geographic_city_names WHERE country_code='RO' AND normalized_name LIKE 'cluj%'")).rows.map(r=>r['QUERY PLAN']).join('\n');expect(plan).toContain('geographic_city_names_prefix_idx');await db.query('RESET enable_seqscan');
  let status=0;for(let i=0;i<125;i++){status=(await get('/api/geography/cities?countryCode=RO&q=cluj','admin')).status;if(status===429)break;}expect(status).toBe(429);
 });
});
