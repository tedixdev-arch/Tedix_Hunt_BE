import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const name = `c7_${randomUUID().replaceAll('-','')}`;
const content = (key:string,version=1) => ({ key,version,displayName:'Saved Local',theme:'Explore',
  mission:{name:'Find',secret:'private mission'},scoring:{startingScore:100},
  configuration:{normalCheckpointCount:1,checkpointPositions:[{checkpointNumber:1,name:'Square',latitude:46,longitude:23,radiusMeters:30,answer:'private point'}],
    finishPoint:{name:'Finish',latitude:46,longitude:23,radiusMeters:10}},
  checkpoints:[{checkpoint:1,kind:'hidden-rule',answer:'private gameplay'},{role:'terminal',navigationMode:'none'}] });
const root='/api/organizer/local-templates';
suite('C7 Organizer Local selection against disposable PostgreSQL',()=>{
  const admin=new Pool({connectionString:testUrl});
  let db:Pool,appPool:Pool,app:ReturnType<typeof import('../app.js').createApp>;
  let jwt:typeof import('../lib/jwt.js').signJwt;
  let templates:typeof import('../models/HuntTemplate.js').HuntTemplates;
  let users:typeof import('../models/User.js').User;
  const actors:Record<string,string>={};
  let org:string,place:string,other:string;
  const migrations:Migration[]=[];
  const auth=(who='organizer')=>`Bearer ${jwt({sub:actors[who],type:'access',roles:['admin','organizer']})}`;
  const get=(path:string,who='organizer')=>request(app).get(path).set('Authorization',auth(who));
  const post=(path:string,body:object,who='creator')=>request(app).post(path).set('Authorization',auth(who)).send(body);
  const query=(id=place,cc='RO')=>`countryCode=${cc}&localityId=${id}`;
  const list=(id=place,cc='RO')=>get(`${root}?${query(id,cc)}`);
  const detail=(a:any,id=place,cc='RO')=>get(`${root}/${a.templateId}/versions/${a.version}?${query(id,cc)}`);
  const body=(a:any,id=place,cc='RO')=>({templateId:a.templateId,version:a.version,countryCode:cc,localityId:id});
  const select=(h:string,a:any,id=place,cc='RO',who='organizer')=>request(app).put(`/api/hunts/${h}/local-template`).set('Authorization',auth(who)).send(body(a,id,cc));
  const state=async(h:string)=>(await db.query('SELECT * FROM hunts WHERE id=$1',[h])).rows[0];
  const locality=async(cc='RO')=>(await db.query(`INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provenance)
    VALUES ($1,'Same name','County',46,23,'private provenance') RETURNING id`,[cc])).rows[0].id;
  const hunt=async(who='organizer')=>{
    const r=await post('/api/hunts',{organizationId:org,name:'Existing draft'},who).expect(201);
    await request(app).patch(`/api/hunts/${r.body.id}`).set('Authorization',auth(who)).send({country:'Presentation Country',region:'Region',city:'City',
      startDate:'2027-01-01',startTime:'10:00',timezone:'Europe/Bucharest',durationMinutes:60,capacity:12,contactName:'Contact',
      format:'team',teamSize:4,accessMode:'invitation_only',difficulty:'easy',checkpointOrder:'recommended'}).expect(200);
    return r.body.id as string;
  };
  const create=async(id:string|null=place,category:string|null='local')=>{
    const key=`c7-${randomUUID()}`;
    const r=await post('/api/creator/templates',{key,content:content(key),...(category?{category}:{}),...(category==='local'?{localityId:id}:{})}).expect(201);
    const identity=(await db.query('SELECT id FROM hunt_templates WHERE key=$1',[key])).rows[0].id;
    expect(r.body.key).toBe(key);return {key,templateId:identity,version:1};
  };
  const submit=(a:any)=>post(`/api/creator/templates/${a.key}/submit`,{version:a.version});
  const approve=(a:any)=>post(`/api/admin/templates/review/${a.key}/approve`,{version:a.version},'admin');
  const suspend=(a:any)=>post(`/api/admin/templates/${a.key}/suspend`,{version:a.version,reason:'private suspension'},'admin');
  const approved=async(id=place)=>{const a=await create(id);await submit(a).expect(200);await approve(a).expect(200);return a;};
  const replacement=async(a:any,id=place)=>{const next={...a,version:a.version+1};await post(`/api/creator/templates/${a.key}/versions`,{content:content(a.key,next.version),localityId:id}).expect(201);return next;};
  const waits=async(n:number)=>{
    await expect.poll(async()=>Number((await db.query(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
      AND cardinality(pg_blocking_pids(pid))>0`)).rows[0].count),{timeout:8000}).toBeGreaterThanOrEqual(n);
  };
  // Real PostgreSQL row locks plus an advisory trigger gate, never sleeps or mocked queries.
  const gate=async(table:string,id:string)=>{
    const controller=await db.connect();
    await controller.query('SELECT pg_advisory_lock(774731)');
    await db.query(`CREATE FUNCTION c7_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${id}'::uuid THEN PERFORM pg_advisory_xact_lock(774731); END IF; RETURN NEW; END $$;
      CREATE TRIGGER c7_gate BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION c7_gate()`);
    return async()=>{await controller.query('SELECT pg_advisory_unlock(774731)');controller.release();};
  };
  const ungate=async(table:string)=>{await db.query(`DROP TRIGGER IF EXISTS c7_gate ON ${table}; DROP FUNCTION IF EXISTS c7_gate()`);};
  beforeAll(async()=>{
    await admin.query(`CREATE DATABASE "${name}"`);
    const url=new URL(testUrl!);url.pathname=`/${name}`;db=new Pool({connectionString:url.toString()});
    const client=await db.connect();
    try{
      await client.query(await readFile(new URL('./pre_migration_baseline.sql',import.meta.url),'utf8'));
      const dir=new URL('./migrations/',import.meta.url);
      for(const file of (await readdir(dir)).filter(f=>/^\d{3}_.*\.ts$/.test(f)).sort()) migrations.push((await import(new URL(file,dir).href)).default);
      await runMigrations(client,migrations.filter(m=>m.id<'027'));
      for(const who of ['creator','admin','organizer','participant','guest','blocked','retired','revoked','multi','outsider','supervisor']){
        const capability=['creator','admin','participant'].includes(who)?who:'organizer';
        actors[who]=(await db.query(`INSERT INTO users(email,role,is_guest,account_status) VALUES($1,'participant',$2,$3) RETURNING id`,
          [`${who}@c7.invalid`,who==='guest',['blocked','retired'].includes(who)?who:'active'])).rows[0].id;
        if(who!=='revoked')await db.query('INSERT INTO user_roles VALUES($1,$2)',[actors[who],capability]);
      }
      await db.query("INSERT INTO user_roles VALUES($1,'creator'),($1,'admin')",[actors.multi]);
      org=(await db.query("INSERT INTO organizations(name,owner_id) VALUES('C7 organization',$1) RETURNING id",[actors.organizer])).rows[0].id;
      for(const who of ['multi','outsider','creator']) await db.query('INSERT INTO organization_members VALUES($1,$2)',[org,actors[who]]);
      place=await locality();other=await locality();await db.query("INSERT INTO countries VALUES('HU','Hungary')");
      // Legacy approvals predate migration 027. No production guard is disabled to fabricate evidence.
      for(const kind of ['independent','unbound','evidenceless','self']){
        const key=`history-${kind}`;
        const id=(await db.query(`INSERT INTO hunt_templates(key,origin,category,created_by_user_id,status) VALUES($1,'creator','local',$2,'draft') RETURNING id`,[key,actors.creator])).rows[0].id;
        const snapshot={id:place,countryCode:'RO',countryDisplayName:'Romania',name:'Same name',administrativeContext:'County',latitude:46,longitude:23};
        await db.query(`INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot)
          VALUES($1,1,$2,'creator','local',$3,$4,$5)`,[id,content(key),actors.creator,kind==='unbound'?null:place,kind==='unbound'?null:snapshot]);
        await db.query("UPDATE hunt_templates SET status='approved',submitted_version=1 WHERE id=$1",[id]);
        if(kind!=='evidenceless')await db.query(`INSERT INTO hunt_template_reviews(template_id,version,reviewer_user_id,decision) VALUES($1,1,$2,'approved')`,[id,kind==='self'?actors.creator:actors.admin]);
      }
      await client.query('ALTER TABLE hunt_templates DROP CONSTRAINT hunt_templates_creator_approved_version_check, DROP CONSTRAINT hunt_templates_submitted_version_fkey');
      for(const kind of ['missing','unresolvable']) {
        const key=`history-${kind}`;
        const id=(await client.query(`INSERT INTO hunt_templates(key,origin,category,created_by_user_id,status,submitted_version)
          VALUES($1,'creator','local',$2,'approved',$3) RETURNING id`,[key,actors.creator,kind==='missing'?null:999])).rows[0].id;
        await client.query(`INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id)
          VALUES($1,1,$2,'creator','local',$3)`,[id,content(key),actors.creator]);
      }
      await client.query(`ALTER TABLE hunt_templates
        ADD CONSTRAINT hunt_templates_creator_approved_version_check CHECK(origin<>'creator' OR status<>'approved' OR submitted_version IS NOT NULL) NOT VALID,
        ADD CONSTRAINT hunt_templates_submitted_version_fkey FOREIGN KEY(id,submitted_version)
          REFERENCES hunt_template_versions(template_id,version) DEFERRABLE INITIALLY DEFERRED NOT VALID`);
      await runMigrations(client,migrations);
    }finally{client.release();}
    const {environment}=await import('../config/environment.js');environment.databaseUrl=url.toString();
    appPool=(await import('../lib/postgres.js')).pool;app=(await import('../app.js')).createApp();jwt=(await import('../lib/jwt.js')).signJwt;
    templates=(await import('../models/HuntTemplate.js')).HuntTemplates;users=(await import('../models/User.js')).User;
  },30000);
  afterAll(async()=>{await appPool?.end();await db?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}"`);await admin.end();});

  it('discovers exact eligible authority, safe preview and server snapshot while preserving all settings',async()=>{
    const a=await approved();const h=await hunt();const before=await state(h);
    const rows=(await list().expect(200)).body.templates;expect(rows.find((v:any)=>v.key===a.key)).toMatchObject({...a,localityId:place});
    const preview=await detail(a).expect(200);expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(Object.keys(preview.body).sort()).toEqual(['configuration','currentLocality','displayName','key','localityId','localitySnapshot','templateId','theme','version']);
    expect(JSON.stringify(preview.body)).not.toMatch(/private|answer|review|provenance|suspension/);
    await select(h,a).expect(200);const after=await state(h);
    expect(after).toMatchObject({template_id:a.templateId,template_key:a.key,template_version:1,template_snapshot:content(a.key),template_locality_id:place});
    for(const key of Object.keys(before).filter(k=>!['template_id','template_key','template_version','template_snapshot','template_locality_id','template_locality_snapshot','updated_at'].includes(k)))expect(after[key]).toEqual(before[key]);
    await get('/api/geography/countries').expect(200);
    expect((await get('/api/geography/localities?countryCode=RO&q=Same').expect(200)).body.localities.some((l:any)=>l.id===place)).toBe(true);
    await get(`/api/geography/localities/${place}`).expect(200);
  });
  it('keeps the old approved locality through draft/submission/changes-requested then switches only on approval',async()=>{
    const a=await approved();const b=await replacement(a,other);
    await detail(a).expect(200);await detail(b,other).expect(404);await submit(b).expect(200);await detail(a).expect(200);
    await post(`/api/admin/templates/review/${a.key}/request-changes`,{version:2,note:'Revise'},'admin').expect(200);
    await detail(a).expect(200);const c=await replacement(b,other);await submit(c).expect(200);await approve(c).expect(200);
    await detail(a).expect(404);await detail(c,other).expect(200);
    await select(await hunt(),a).expect(409,{error:'template_selection_stale'});
    const h=await hunt();await select(h,{...a,version:1},other).expect(409,{error:'template_selection_stale'});expect((await state(h)).template_snapshot).toBeNull();
  });
  it.each(['draft','submitted','changes_requested'])('excludes first %s candidates',async status=>{
    const a=await create();if(status!=='draft')await submit(a).expect(200);
    if(status==='changes_requested')await post(`/api/admin/templates/review/${a.key}/request-changes`,{version:1,note:'Revise'},'admin').expect(200);
    await detail(a).expect(404);await select(await hunt(),a).expect(409,{error:'template_not_eligible'});
  });
  it('retains suspension after replacement approval and locality reactivation',async()=>{
    const a=await approved();await suspend(a).expect(200);const audit=(await db.query('SELECT local_suspended_at,local_suspension_reason,local_suspended_version FROM hunt_templates WHERE id=$1',[a.templateId])).rows[0];
    const b=await replacement(a);await submit(b).expect(200);await approve(b).expect(200);
    await db.query('UPDATE localities SET active=false WHERE id=$1',[place]);await db.query('UPDATE localities SET active=true WHERE id=$1',[place]);
    await detail(b).expect(404);await select(await hunt(),b).expect(409,{error:'template_not_eligible'});
    expect((await db.query('SELECT local_suspended_at,local_suspension_reason,local_suspended_version FROM hunt_templates WHERE id=$1',[a.templateId])).rows[0]).toEqual(audit);
  });
  it.each(['independent','unbound','evidenceless','self','missing','unresolvable'])('resolves historical %s without capturing or rewriting authority',async kind=>{
    const identity=(await db.query('SELECT * FROM hunt_templates WHERE key=$1',[`history-${kind}`])).rows[0];const a={key:identity.key,templateId:identity.id,version:1};
    await detail(a).expect(kind==='independent'?200:404);await select(await hunt(),a).expect(kind==='independent'?200:409);
    expect((await db.query('SELECT * FROM hunt_templates WHERE id=$1',[identity.id])).rows[0]).toEqual(identity);
  });
  it.each(['latitude','longitude','country_code','active','name'])('handles %s catalog drift and retains saved labels',async field=>{
    const id=await locality();const a=await approved(id);const h=await hunt();
    await db.query(`UPDATE localities SET ${field}=$2 WHERE id=$1`,[id,field==='active'?false:field==='country_code'?'HU':field==='name'?'New name':47]);
    const expected=field==='name'?200:field==='active'?409:404;
    await detail(a,id).expect(expected);
    const response=await select(h,a,id).expect(field==='name'?200:409);
    if(field==='name'){expect(response.body.templateLocalitySnapshot.name).toBe('Same name');expect((await detail(a,id).expect(200)).body.currentLocality.name).toBe('New name');}
    else expect(response.body.error).toBe(field==='active'?'locality_unavailable':'locality_geography_changed');
  });
  it('filters exact country/UUID and rejects proposal IDs and cross-country inference',async()=>{
    const id=await locality('HU');const a=await approved(id);
    await list(id,'HU').expect(200);await list(id).expect(404);await list(randomUUID()).expect(404);await list(place,'ZZ').expect(400);
    expect((await list(other).expect(200)).body.templates.every((a:any)=>a.localityId===other)).toBe(true);
    await detail(a,id,'HU').expect(200);await select(await hunt(),a,place).expect(409,{error:'template_not_eligible'});
  });
  it.each(['templateSnapshot','content','key','templateVersion','localitySnapshot','name'])('rejects forged or forbidden %s',async field=>{
    const a=await approved();const h=await hunt();const before=await state(h);
    await request(app).put(`/api/hunts/${h}/local-template`).set('Authorization',auth()).send({...body(a),[field]:{forged:true}}).expect(400,{error:'invalid_input'});
    expect(await state(h)).toEqual(before);
  });
  it.each(['foo=x','limit=0','limit=51','limit=1.5','cursor=bad','version=1','countryCode=ro','localityId=bad'])('rejects malformed discovery %s',async suffix=>{
    await get(`${root}?${query()}&${suffix}`).expect(400,{error:'invalid_input'});
  });
  it.each(['0','-1','1.1','2147483648','word'])('rejects invalid detail version %s',async v=>{
    await get(`${root}/${randomUUID()}/versions/${v}?${query()}`).expect(400);
  });
  it('accepts UUID case variants and rejects unsupported body versions without changing the draft',async()=>{
    const a=await approved();const h=await hunt();await select(h,{...a,templateId:a.templateId.toUpperCase()},place.toUpperCase()).expect(200);
    const before=await state(h);
    for(const invalid of [0,-1,1.5,2147483648,'1',null]) {
      await request(app).put(`/api/hunts/${h}/local-template`).set('Authorization',auth()).send({...body(a),version:invalid}).expect(400);
      expect(await state(h)).toEqual(before);
    }
  });
  it('paginates opaque filter-scoped cursors without duplicates',async()=>{
    const id=await locality();for(let n=0;n<3;n++)await approved(id);
    const seen:string[]=[];let cursor='';do{const r=await get(`${root}?${query(id)}&limit=1${cursor?`&cursor=${cursor}`:''}`).expect(200);seen.push(...r.body.templates.map((a:any)=>a.key));cursor=r.body.nextCursor??'';
      if(cursor)await get(`${root}?${query(other)}&limit=1&cursor=${cursor}`).expect(400);
    }while(cursor);expect(seen).toHaveLength(3);expect(new Set(seen).size).toBe(3);expect(seen).toEqual([...seen].sort());
  });
  it.each(['participant','creator','admin','guest','blocked','retired','revoked'])('denies %s before artifact lookup',async who=>{
    const status=['blocked','retired'].includes(who)?401:403;
    await get(`${root}?invalid=x`,who).expect(status);await select(randomUUID(),{templateId:randomUUID(),version:1},place,'RO',who).expect(status);
  });
  it('permits multi-role and unrelated Creator templates, denies other Hunt/Supervisor and organization-only access',async()=>{
    const a=await approved();const h=await hunt();await select(h,a,place,'RO','multi').expect(403);
    await db.query("INSERT INTO hunt_roles VALUES($1,$2,'supervisor')",[h,actors.multi]);await select(h,a,place,'RO','multi').expect(403);
    await select(await hunt('multi'),a,place,'RO','multi').expect(200);
    await select(h,{templateId:randomUUID(),version:1},place,'RO','outsider').expect(403);
  });
  it('protects C7 from legacy replacement, allows settings and explicit whole-source replacement',async()=>{
    const h=await hunt();await request(app).patch(`/api/hunts/${h}`).set('Authorization',auth()).send({templateKey:'signal-cluj-napoca'}).expect(200);
    const a=await approved();await select(h,a).expect(200);const old=await state(h);
    await request(app).patch(`/api/hunts/${h}`).set('Authorization',auth()).send({templateKey:'signal-cluj-napoca'}).expect(409,{error:'template_selection_conflict'});
    expect(await state(h)).toEqual(old);await request(app).patch(`/api/hunts/${h}`).set('Authorization',auth()).send({name:'New name'}).expect(200);
    const b=await approved(other);await select(h,b,other).expect(200);expect((await state(h)).template_id).toBe(b.templateId);
  });
  it.each(['local','universal'])('keeps classified %s keys out of every legacy path',async category=>{
    const a=category==='local'?await approved():await create(null,'universal');
    if(category==='universal'){await submit(a).expect(200);await approve(a).expect(200);}
    expect((await get('/api/hunt-templates').expect(200)).body.some((t:any)=>t.key===a.key)).toBe(false);
    await get(`/api/hunt-templates/${a.key}/geography`).expect(404);await request(app).patch(`/api/hunts/${await hunt()}`).set('Authorization',auth()).send({templateKey:a.key}).expect(400);
    if(category==='universal')await detail(a).expect(404);
  });
  it.each(['published','active','paused','finished','cancelled'])('rejects reselection of %s and preserves history after approval/suspension/catalog changes',async status=>{
    const id=await locality();const a=await approved(id);const h=await hunt();await select(h,a,id).expect(200);
    await db.query('UPDATE hunts SET status=$2 WHERE id=$1',[h,status]);const before=await state(h);
    const b=await replacement(a,id);await submit(b).expect(200);await approve(b).expect(200);await suspend(b).expect(200);await db.query('UPDATE localities SET active=false WHERE id=$1',[id]);
    await select(h,b,id).expect(409,{error:'invalid_hunt_state'});expect(await state(h)).toEqual(before);
  });
  for(const first of ['selection','writer'])it.each(['approval','suspension','deactivation','correction','rename'])(`${first}-first %s serializes exact source and returns prescribed conflicts`,async change=>{
    const id=await locality();const a=await approved(id);const h=await hunt();const before=await state(h);
    let b=a;if(change==='approval'){b=await replacement(a,id);await submit(b).expect(200);}
    const table=first==='selection'?'hunts':['approval','suspension'].includes(change)?'hunt_templates':'localities';
    const target=first==='selection'?h:['approval','suspension'].includes(change)?a.templateId:id;
    const release=await gate(table,target);
    const writer=()=>change==='approval'?approve(b).then(r=>{expect(r.status).toBe(200);}):change==='suspension'?suspend(a).then(r=>{expect(r.status).toBe(200);}):
      db.query(`UPDATE localities SET ${change==='deactivation'?'active=false':change==='correction'?'latitude=47':"name='Renamed'"} WHERE id=$1`,[id]);
    let one:Promise<unknown>|undefined,two:Promise<unknown>|undefined;
    try{
      if(first==='selection'){
        one=select(h,a,id).then(r=>{expect(r.status).toBe(200);});await waits(1);two=writer();await waits(2);
      }else{
        one=writer();await waits(1);two=select(h,a,id).then(r=>{
          expect(r.status).toBe(change==='rename'?200:409);
          if(change!=='rename')expect(r.body.error).toBe(change==='approval'?'template_selection_stale':change==='suspension'?'template_not_eligible':change==='deactivation'?'locality_unavailable':'locality_geography_changed');
        });await waits(2);
      }
    }finally{await release();await Promise.all([one,two]);await ungate(table);}
    const after=await state(h);
    if(first==='selection'||change==='rename')expect(after).toMatchObject({template_id:a.templateId,template_version:1,template_snapshot:content(a.key),template_locality_id:id});
    else expect(after).toEqual(before);
  },20000);

  for(const first of ['selection','writer'])it.each(['block','retire','capability','hunt-role'])(`${first}-first authorization %s protects or rechecks persisted rows`,async change=>{
    const who=`race-${randomUUID()}`;
    actors[who]=(await db.query("INSERT INTO users(email,role) VALUES($1,'participant') RETURNING id",[`${who}@c7.invalid`])).rows[0].id;
    await db.query("INSERT INTO user_roles VALUES($1,'organizer')",[actors[who]]);await db.query('INSERT INTO organization_members VALUES($1,$2)',[org,actors[who]]);
    const a=await approved();const h=await hunt(who);const before=await state(h);
    if(first==='selection'){
      const release=await gate('hunts',h);let selected:Promise<unknown>|undefined,writer:Promise<unknown>|undefined;
      try{
        selected=select(h,a,place,'RO',who).then(r=>{expect(r.status).toBe(200);});await waits(1);
        writer=change==='block'?users.setAccountStatus(actors[who],'blocked'):change==='retire'?users.deleteControlled(actors[who]):
          db.query(change==='capability'?"DELETE FROM user_roles WHERE user_id=$1 AND role='organizer'":"DELETE FROM hunt_roles WHERE user_id=$1 AND role='organizer'",[actors[who]]);
        await waits(2);
      }finally{await release();await Promise.all([selected,writer]);await ungate('hunts');}
      expect((await state(h)).template_id).toBe(a.templateId);
    }else{
      const client=await db.connect();let pending:Promise<unknown>|undefined;
      try{
        await client.query('BEGIN');
        await client.query(change==='block'||change==='retire'?`UPDATE users SET account_status='${change==='block'?'blocked':'retired'}' WHERE id=$1`:
          change==='capability'?"DELETE FROM user_roles WHERE user_id=$1 AND role='organizer'":"DELETE FROM hunt_roles WHERE user_id=$1 AND role='organizer'",[actors[who]]);
        pending=select(h,a,place,'RO',who).then(r=>{expect(r.status).toBe(['block','retire'].includes(change)?401:403);});await waits(1);
      }finally{await client.query('COMMIT');client.release();await pending;}
      expect(await state(h)).toEqual(before);
    }
  },20000);

  it.each(['selection','legacy','publish'])('serializes selection-first with concurrent %s on the same Hunt',async action=>{
    const a=await approved();const b=await approved(other);const h=await hunt();
    if(action==='publish')await select(h,b,other).expect(200);
    const release=await gate('hunts',h);
    let one:Promise<unknown>|undefined,two:Promise<unknown>|undefined;
    try{
      one=select(h,a).then(r=>expect(r.status).toBe(200));await waits(1);
      two=action==='selection'?select(h,b,other).then(r=>expect(r.status).toBe(200)):
        action==='legacy'?request(app).patch(`/api/hunts/${h}`).set('Authorization',auth()).send({templateKey:'signal-cluj-napoca'}).then(r=>expect(r.body).toEqual({error:'template_selection_conflict'})):
        post(`/api/hunts/${h}/publish`,{},'organizer').then(r=>expect(r.status).toBe(200));
      await waits(2);
    }finally{await release();await Promise.all([one,two]);await ungate('hunts');}
    expect((await state(h)).template_id).toBe(action==='selection'?b.templateId:a.templateId);
  },20000);
  it('legacy-first PATCH commits before explicit Local selection replaces the whole source',async()=>{
    const a=await approved();const h=await hunt();const release=await gate('hunts',h);
    let legacy:Promise<unknown>|undefined,selection:Promise<unknown>|undefined;
    try{
      legacy=request(app).patch(`/api/hunts/${h}`).set('Authorization',auth()).send({templateKey:'signal-cluj-napoca'}).then(r=>expect(r.status).toBe(200));await waits(1);
      selection=select(h,a).then(r=>expect(r.status).toBe(200));await waits(2);
    }finally{await release();await Promise.all([legacy,selection]);await ungate('hunts');}
    expect((await state(h)).template_snapshot).toEqual(content(a.key));
  },20000);
  it('publish-first forces selection to recheck draft after waiting',async()=>{
    const a=await approved();const h=await hunt();await select(h,a).expect(200);const release=await gate('hunts',h);
    let pub:Promise<unknown>|undefined,sel:Promise<unknown>|undefined;
    try{pub=post(`/api/hunts/${h}/publish`,{},'organizer').then(r=>expect(r.status).toBe(200));await waits(1);
      sel=select(h,a).then(r=>expect(r.body).toEqual({error:'invalid_hunt_state'}));await waits(2);
    }finally{await release();await Promise.all([pub,sel]);await ungate('hunts');}
    expect((await state(h)).status).toBe('published');
  },20000);
  it.each(['save','approve','request-changes','suspend'])('locks actor before Template for %s against account blocking',async operation=>{
    const a=await approved();let candidate=a;
    if(operation==='approve'||operation==='request-changes') {candidate=await replacement(a);await submit(candidate).expect(200);}
    const actor=operation==='save'?'creator':'admin';
    const client=await db.connect();let writer:Promise<unknown>|undefined,blocker:Promise<unknown>|undefined;
    try{
      await client.query('BEGIN');await client.query('SELECT id FROM hunt_templates WHERE id=$1 FOR UPDATE',[a.templateId]);
      writer=operation==='save'?templates.createCreatorVersion(a.key,content(a.key,2),actors.creator):
        operation==='approve'?templates.approveSubmittedCreator(a.key,actors.admin,candidate.version):
        operation==='request-changes'?templates.requestChangesForSubmittedCreator(a.key,actors.admin,candidate.version):templates.suspendLocal(a.key,1,actors.admin,'Protective action');
      await waits(1);blocker=users.setAccountStatus(actors[actor],'blocked');await waits(2);
    }finally{
      await client.query('COMMIT');client.release();await Promise.all([writer,blocker]);
      await db.query("UPDATE users SET account_status='active' WHERE id=$1",[actors[actor]]);
    }
    expect((await db.query('SELECT account_status FROM users WHERE id=$1',[actors[actor]])).rows[0].account_status).toBe('active');
  },20000);
  it.each([false,true])('rolls back complete tuple on injected deferred=%s database failure and reuses pool',async deferred=>{
    const a=await approved();const h=await hunt();await select(h,a).expect(200);const before=await state(h);const b=await approved();
    await db.query(`CREATE FUNCTION c7_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${h}'::uuid THEN RAISE EXCEPTION 'injected failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
      ${deferred?'CREATE CONSTRAINT TRIGGER c7_fail AFTER UPDATE ON hunts DEFERRABLE INITIALLY DEFERRED':'CREATE TRIGGER c7_fail BEFORE UPDATE ON hunts'}
      FOR EACH ROW EXECUTE FUNCTION c7_fail()`);
    try{await select(h,b).expect(500);expect(await state(h)).toEqual(before);}
    finally{await db.query('DROP TRIGGER c7_fail ON hunts; DROP FUNCTION c7_fail()');}
    await select(h,b).expect(200);expect((await state(h)).template_id).toBe(b.templateId);
  });
  it('matches migration/rerun/fresh schema, rejects partial/forged SQL sources and restricts source deletion',async()=>{
    const client=await db.connect();
    const inspect=async()=>({
      columns:(await client.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='hunts' ORDER BY column_name")).rows,
      constraints:(await client.query("SELECT conname,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='hunts'::regclass AND conname IN('hunts_local_source_pair_check','hunts_template_source_fkey','hunts_template_locality_id_fkey') ORDER BY conname")).rows,
      triggers:(await client.query("SELECT tgname,pg_get_triggerdef(oid) def FROM pg_trigger WHERE tgrelid='hunts'::regclass AND tgname='hunts_local_source_protection'")).rows.map(r=>({...r,def:r.def.replace(/ ON [^ ]+\./,' ON ')})),
      function:(await client.query("SELECT prosrc FROM pg_proc WHERE oid='protect_hunt_local_source()'::regprocedure")).rows,
    });
    try{
      expect(await runMigrations(client,migrations)).toEqual([]);const upgraded=await inspect();
      await client.query('BEGIN; CREATE SCHEMA c7_fresh; SET LOCAL search_path TO c7_fresh,public');
      await client.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));expect(await inspect()).toEqual(upgraded);
    }finally{await client.query('ROLLBACK');client.release();}
    const a=await approved();const h=await hunt();const before=await state(h);
    await expect(db.query('UPDATE hunts SET template_id=$2 WHERE id=$1',[h,a.templateId])).rejects.toMatchObject({code:'23514'});expect(await state(h)).toEqual(before);
    await select(h,a).expect(200);
    for(const sql of ["template_snapshot='{}'::jsonb","template_key='forged'","template_locality_snapshot='{}'::jsonb","template_id=NULL,template_locality_id=NULL,template_locality_snapshot=NULL"])
      await expect(db.query(`UPDATE hunts SET ${sql} WHERE id=$1`,[h])).rejects.toMatchObject({code:'23514'});
    await expect(db.query('DELETE FROM hunt_template_versions WHERE template_id=$1',[a.templateId])).rejects.toBeDefined();
    await expect(db.query('DELETE FROM localities WHERE id=$1',[place])).rejects.toMatchObject({code:'23503'});
  });
  it('does not apply live eligibility as a new publish/start gate and preserves Participant projection',async()=>{
    const id=await locality();const a=await approved(id);const h=await hunt();await select(h,a,id).expect(200);const before=await state(h);
    await suspend(a).expect(200);await db.query('UPDATE localities SET active=false WHERE id=$1',[id]);
    await post(`/api/hunts/${h}/publish`,{},'organizer').expect(200);await post(`/api/hunts/${h}/start`,{},'organizer').expect(200);
    const after=await state(h);expect(after.template_snapshot).toEqual(before.template_snapshot);expect(after.template_locality_snapshot).toEqual(before.template_locality_snapshot);
    const access=await post(`/api/hunts/${h}/access`,{},'organizer').expect(200);
    const projection=await get(`/api/hunt-access/${access.body.code}`,'participant');
    expect(projection.status).toBe(200);
    expect(projection.body).toEqual({huntId:h,code:access.body.code,name:'Existing draft',status:'active'});
  });

  it('returns an empty active catalog and preserves a selected draft through later source changes',async()=>{
    const id=await locality();expect((await list(id).expect(200)).body).toEqual({templates:[],nextCursor:null});
    const a=await approved(id);const h=await hunt();await select(h,a,id).expect(200);const saved=await state(h);
    const b=await replacement(a,id);await submit(b).expect(200);await approve(b).expect(200);await suspend(b).expect(200);
    await db.query('UPDATE localities SET latitude=48,active=false WHERE id=$1',[id]);expect(await state(h)).toEqual(saved);
  });
  it('rejects malformed immutable locality pairs at the database boundary',async()=>{
    const a=await create();const snapshot=(await db.query('SELECT locality_snapshot FROM hunt_template_versions WHERE template_id=$1',[a.templateId])).rows[0].locality_snapshot;
    for(const saved of [{...snapshot,id:randomUUID()},{...snapshot,latitude:'46'},{...snapshot,longitude:181},{...snapshot,provenance:'private'}])
      await expect(db.query(`INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot)
        VALUES($1,2,$2,'creator','local',$3,$4,$5)`,[a.templateId,content(a.key,2),actors.creator,place,saved])).rejects.toMatchObject({code:'23514'});
    await expect(db.query(`INSERT INTO hunt_template_versions(template_id,version,content,origin,category,created_by_user_id,locality_id)
      VALUES($1,2,$2,'creator','local',$3,$4)`,[a.templateId,content(a.key,2),actors.creator,place])).rejects.toMatchObject({code:'23514'});
  });
  it('retains exact saved authority when historical reviewer and Creator are retired',async()=>{
    const a=await approved();
    // Independent evidence does not depend on present capability. Restore actors after the check.
    await db.query("UPDATE users SET account_status='retired' WHERE id=ANY($1::uuid[])",[[actors.creator,actors.admin]]);
    try{await detail(a).expect(200);await select(await hunt(),a).expect(200);}
    finally{await db.query("UPDATE users SET account_status='active' WHERE id=ANY($1::uuid[])",[[actors.creator,actors.admin]]);}
    expect(await templates.getVersion(a.templateId,1)).not.toBeNull();
  });
});
