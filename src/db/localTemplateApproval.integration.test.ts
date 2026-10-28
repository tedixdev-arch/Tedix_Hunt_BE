import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from './migrate.js';
import approvalMigration from './migrations/027_local_template_approval.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const databaseName = `c6b5_${randomUUID().replaceAll('-', '')}`;
const root = '/api/creator/templates';
const content = (key: string, version = 1) => ({ key, version, displayName: 'Local continuity', theme: 'Explore',
  mission: { name: 'Find' }, scoring: { startingScore: 100 },
  configuration: { normalCheckpointCount: 1,
    checkpointPositions: [{ checkpointNumber: 1, name: 'Square', latitude: 46, longitude: 23, radiusMeters: 30 }],
    finishPoint: { name: 'Finish', latitude: 46, longitude: 23, radiusMeters: 10 } },
  checkpoints: [{ checkpoint: 1, kind: 'hidden-rule' }, { role: 'terminal', navigationMode: 'none' }],
});

suite('C6b-5 Local approval continuity against disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let appPool: Pool;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let model: typeof import('../models/HuntTemplate.js');
  let users: typeof import('../models/User.js');
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  const actors: Record<string, string> = {};
  let place: string;
  let historicalHunts: unknown;
  const migrations: Migration[] = [];
  const auth = (role = 'creator') => `Bearer ${signJwt({ sub: actors[role], type: 'access', roles: ['creator','admin'] })}`;
  const post = (path: string, body: object, role = 'creator') => request(app).post(path).set('Authorization', auth(role)).send(body);
  const get = (path: string, role = 'creator') => request(app).get(path).set('Authorization', auth(role));
  const create = async (localityId: string | null = place, category = 'local') => {
    const key = `continuity-${randomUUID()}`;
    await post(root, { key, category, content: content(key), ...(category === 'local' ? { localityId } : {}) }).expect(201);
    return key;
  };
  const save = (key: string, version: number, selection: object = {}) => post(`${root}/${key}/versions`, { content: content(key,version), ...selection });
  const submit = (key: string, version: number) => post(`${root}/${key}/submit`, { version });
  const decide = (key: string, version: number, decision = 'approve', actor = 'admin') => post(`/api/admin/templates/review/${key}/${decision}`, { version }, actor);
  const suspend = (key: string, version: number, actor = 'admin') => post(`/api/admin/templates/${key}/suspend`, { version, reason: 'Explicit geographic eligibility decision' }, actor);
  const inspect = (key: string) => get(`/api/admin/templates/review/${key}?view=approved`, 'admin');
  const state = async (key: string) => ({
    identity: (await db.query('SELECT * FROM hunt_templates WHERE key=$1', [key])).rows,
    versions: (await db.query(`SELECT v.* FROM hunt_template_versions v JOIN hunt_templates t ON t.id=v.template_id WHERE t.key=$1 ORDER BY version`, [key])).rows,
    reviews: (await db.query(`SELECT r.* FROM hunt_template_reviews r JOIN hunt_templates t ON t.id=r.template_id WHERE t.key=$1 ORDER BY version`, [key])).rows,
  });
  const locality = async () => (await db.query(`INSERT INTO localities (country_code,name,administrative_context,latitude,longitude,provenance)
    VALUES ('RO','Place','County',46,23,'Independent registry fixture') RETURNING id`)).rows[0].id;
  const approved = async () => { const key = await create(); await submit(key,1).expect(200); await decide(key,1).expect(200); return key; };
  const blockedBy = async (client: PoolClient) => {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await expect.poll(async () => Number((await db.query('SELECT count(*) FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rows[0].count), { timeout: 5000 }).toBeGreaterThan(0);
  };
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(testUrl!); url.pathname=`/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('./pre_migration_baseline.sql', import.meta.url),'utf8'));
      const directory = new URL('./migrations/', import.meta.url);
      for (const file of (await readdir(directory)).filter(n => /^\d{3}_.*\.ts$/.test(n) && n < '027').sort()) migrations.push((await import(new URL(file,directory).href)).default);
      await runMigrations(client,migrations);
      for (const role of ['creator','other','admin','secondAdmin','guest','blocked','retired','revoked','organizer']) {
        const capability = ['admin','secondAdmin'].includes(role) ? 'admin' : role === 'organizer' ? 'organizer' : 'creator';
        actors[role]=(await db.query(`INSERT INTO users (email,role,is_guest,account_status) VALUES ($1,$2,$3,$4) RETURNING id`,
          [`${role}@continuity.invalid`,capability,role==='guest',['blocked','retired'].includes(role)?role:'active'])).rows[0].id;
        await db.query('INSERT INTO user_roles VALUES ($1,$2)',[actors[role],capability]);
      }
      await db.query("INSERT INTO user_roles VALUES ($1,'admin')",[actors.creator]);
      await db.query('DELETE FROM user_roles WHERE user_id=$1',[actors.revoked]);
      place=await locality();
      // Historical cases are created before 027, never fabricated by application operations.
      for (const kind of ['evidence','evidence-free','self','bound','inconsistent','pending']) {
        const key=`historical-${kind}`;
        const id=(await db.query(`INSERT INTO hunt_templates (key,origin,category,created_by_user_id,status)
          VALUES ($1,'creator','local',$2,'draft') RETURNING id`,[key,actors.creator])).rows[0].id;
        const snap={id:place,countryCode:'RO',countryDisplayName:'Romania',name:'Place',administrativeContext:'County',latitude:46,longitude:23};
        await db.query(`INSERT INTO hunt_template_versions (template_id,version,content,origin,category,created_by_user_id,locality_id,locality_snapshot)
          VALUES ($1,1,$2,'creator','local',$3,$4,$5)`,[id,content(key),actors.creator,kind==='bound'?place:null,kind==='bound'?snap:null]);
        if (kind==='inconsistent') await db.query(`INSERT INTO hunt_template_versions (template_id,version,content,origin,category,created_by_user_id) VALUES ($1,2,$2,'creator','local',$3)`,[id,content(key,2),actors.creator]);
        await db.query('UPDATE hunt_templates SET status=$2,submitted_version=1 WHERE id=$1',[id,kind==='pending'?'submitted':'approved']);
        if (['evidence','self','bound'].includes(kind)) await db.query(`INSERT INTO hunt_template_reviews (template_id,version,reviewer_user_id,decision) VALUES ($1,1,$2,'approved')`,[id,kind==='self'?actors.creator:actors.admin]);
      }
      await client.query('ALTER TABLE hunt_templates DROP CONSTRAINT hunt_templates_creator_approved_version_check, DROP CONSTRAINT hunt_templates_submitted_version_fkey');
      for (const kind of ['missing','unresolvable']) {
        const key=`historical-${kind}`;
        const id=(await client.query(`INSERT INTO hunt_templates (key,origin,category,created_by_user_id,status,submitted_version)
          VALUES ($1,'creator','local',$2,'approved',$3) RETURNING id`,[key,actors.creator,kind==='missing'?null:999])).rows[0].id;
        await client.query(`INSERT INTO hunt_template_versions (template_id,version,content,origin,category,created_by_user_id)
          VALUES ($1,1,$2,'creator','local',$3)`,[id,content(key),actors.creator]);
      }
      await client.query(`ALTER TABLE hunt_templates
        ADD CONSTRAINT hunt_templates_creator_approved_version_check CHECK (origin<>'creator' OR status<>'approved' OR submitted_version IS NOT NULL) NOT VALID,
        ADD CONSTRAINT hunt_templates_submitted_version_fkey FOREIGN KEY (id,submitted_version)
          REFERENCES hunt_template_versions(template_id,version) DEFERRABLE INITIALLY DEFERRED NOT VALID`);
      const inventorySql=await readFile(new URL('../../docs/sql/local-approval-inventory.sql',import.meta.url),'utf8');
      const inventory = await client.query(inventorySql) as any;
      const rows=inventory.find((r: any)=>r.command==='SELECT').rows;
      expect(rows).toHaveLength(7);
      expect(rows.filter((r:any)=>r.independent_evidence)).toHaveLength(2);
      expect(rows.filter((r:any)=>!r.independent_evidence)).toHaveLength(5);
      expect(rows.filter((r:any)=>!r.locality_bound)).toHaveLength(6);
      expect(rows.filter((r:any)=>r.inconsistent_pin)).toHaveLength(3);
      console.log('C6b-5 compatibility inventory:',JSON.stringify(rows));
      const organization=(await db.query("INSERT INTO organizations (name,owner_id) VALUES ('C6b-5 history',$1) RETURNING id",[actors.creator])).rows[0].id;
      await db.query(`INSERT INTO hunts (organization_id,created_by_user_id,name,status,template_key,template_version,template_snapshot)
        SELECT $1,$2,'Historical Signal Hunt','finished',t.key,v.version,v.content FROM hunt_templates t
        JOIN hunt_template_versions v ON v.template_id=t.id AND v.version=1 WHERE t.key='signal-cluj-napoca'`,[organization,actors.creator]);
      historicalHunts=(await db.query('SELECT * FROM hunts ORDER BY id')).rows;
      const historical = await db.query('SELECT * FROM hunt_template_versions ORDER BY id');
      const reviewHistory = await db.query('SELECT * FROM hunt_template_reviews ORDER BY template_id,version');
      migrations.push(approvalMigration);
      expect(await runMigrations(client,migrations)).toEqual(['027_local_template_approval']);
      expect(await runMigrations(client,migrations)).toEqual([]);
      expect((await db.query('SELECT * FROM hunt_template_versions ORDER BY id')).rows).toEqual(historical.rows);
      expect((await db.query('SELECT * FROM hunt_template_reviews ORDER BY template_id,version')).rows).toEqual(reviewHistory.rows);
      expect((await db.query('SELECT * FROM hunts ORDER BY id')).rows).toEqual(historicalHunts);
      expect((await db.query('SELECT count(*) FROM hunt_templates WHERE local_approved_version IS NOT NULL OR local_suspended_at IS NOT NULL')).rows[0].count).toBe('0');
    } finally { client.release(); }
    const {environment}=await import('../config/environment.js');environment.databaseUrl=url.toString();
    appPool=(await import('../lib/postgres.js')).pool;
    app=(await import('../app.js')).createApp(); model=await import('../models/HuntTemplate.js');
    users=await import('../models/User.js'); signJwt=(await import('../lib/jwt.js')).signJwt;
  },30_000);
  afterAll(async () => { await appPool?.end(); await db?.end(); await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);await admin.end(); });

  it('matches fresh schema constraints and Local authority functions after upgrade/rerun',async()=>{
    const client=await db.connect();
    const inspectSchema=async()=>({
      columns:(await client.query(`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='hunt_templates' ORDER BY column_name`)).rows,
      constraints:(await client.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='hunt_templates'::regclass AND conname LIKE 'hunt_templates_local_%' ORDER BY conname`)).rows,
      triggers:(await client.query("SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid='hunt_template_reviews'::regclass AND tgname='hunt_template_reviews_local_approval_binding'")).rows.map(r=>({ ...r, definition:r.definition.replace(/ ON [^ ]+\./,' ON ') })),
      functions:await Promise.all(['protect_local_template_authority','enforce_local_template_approval','bind_local_approval_review'].map(async name=>(await client.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',[`${name}()`])).rows)),
    });
    try { const upgraded=await inspectSchema();await client.query('BEGIN; CREATE SCHEMA fresh_local; SET LOCAL search_path TO fresh_local,public');
      await client.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));expect(await inspectSchema()).toEqual(upgraded);
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('preserves v1 through replacement v2, changes requested, v3 and switches only at independent approval',async()=>{
    const key=await approved(); const original=(await state(key)).versions[0];
    const b=await locality();
    for(const version of [2,3]){
      await save(key,version,{localityId:b}).expect(201);
      expect((await inspect(key).expect(200)).body).toMatchObject({version:1,localityId:place,content:content(key),candidateStatus:'draft'});
      const owner=(await get(`${root}/${key}`).expect(200)).body;
      expect(owner).toMatchObject({version,localApprovedVersion:1,localApproval:{version:1,independentEvidence:true}});
      await submit(key,version).expect(200);
      await decide(key,version,'approve','creator').expect(403,{error:'template_self_approval_forbidden'});
      if(version===2)await decide(key,version,'request-changes').expect(200);
    }
    await decide(key,2).expect(409); await decide(key,3).expect(200);
    expect((await inspect(key).expect(200)).body).toMatchObject({version:3,localityId:b,content:content(key,3)});
    expect((await state(key)).versions[0]).toEqual(original);
    expect((await state(key)).reviews.map(r=>[r.version,r.decision])).toEqual([[1,'approved'],[2,'changes_requested'],[3,'approved']]);
    expect((await get(root).expect(200)).body.find((t:any)=>t.key===key)).toMatchObject({version:3,localApprovedVersion:3});
  });
  it.each(['evidence-free','self'])('blocks historical %s revision, retains exact pin and permits evidence-free protective suspension',async kind=>{
    const key=`historical-${kind}`; const before=await state(key);
    await save(key,2).expect(409,{error:'template_approval_evidence_required'});expect(await state(key)).toEqual(before);
    expect((await inspect(key).expect(200)).body).toMatchObject({version:1,localApprovedVersion:null,localApproval:{authority:'historical',independentEvidence:false}});
    await suspend(key,1).expect(200);
    const after=await state(key);expect(after.identity[0]).toMatchObject({local_approved_version:null,status:'approved',submitted_version:1,local_suspended_version:1});
    expect(after.reviews).toEqual(before.reviews);expect(after.versions).toEqual(before.versions);
  });
  it('lazily captures evidence-backed unbound authority and retains its immutable unbound artifact',async()=>{
    const key='historical-evidence';await save(key,2,{localityId:place}).expect(201);
    expect((await inspect(key).expect(200)).body).toMatchObject({version:1,localityId:null,localApprovedVersion:1,localApproval:{independentEvidence:true,localityBound:false}});
    await submit(key,2).expect(200);await decide(key,2).expect(200);
    expect((await inspect(key).expect(200)).body).toMatchObject({version:2,localityId:place});
  });
  it.each(['missing','unresolvable'])('surfaces historical %s authority explicitly without choosing latest or mutating history',async kind=>{
    const key=`historical-${kind}`;const before=await state(key);
    const inspected=(await inspect(key).expect(200)).body;
    expect(inspected.version).toBeNull();expect(inspected.localApproval.authority).toBe('integrity_exception');
    expect(inspected.content).toBeNull();expect(inspected.candidateVersion).toBe(1);
    expect((await get(`${root}/${key}`).expect(200)).body.localApproval.authority).toBe('integrity_exception');
    await save(key,2).expect(409,{error:'template_approval_evidence_required'});
    await suspend(key,kind==='missing'?1:999).expect(409,{error:'template_eligibility_conflict'});
    expect(await state(key)).toEqual(before);
  });
  it('rejects unbound new submissions and old pending approvals, but still requests changes',async()=>{
    const key=await create(null);const before=await state(key);
    await submit(key,1).expect(400,{error:'locality_required'});expect(await state(key)).toEqual(before);
    const old=await state('historical-pending');await decide('historical-pending',1).expect(400,{error:'locality_required'});expect(await state('historical-pending')).toEqual(old);
    await decide('historical-pending',1,'request-changes').expect(200);
  });
  it.each(['active','country_code','latitude','longitude'])('rejects material %s changes at both submission and approval without writes',async field=>{
    for(const phase of ['submission','approval']){
      const id=await locality();const key=await create(id);
      if(phase==='approval')await submit(key,1).expect(200);
      const before=await state(key);
      if(field==='country_code')await db.query("INSERT INTO countries VALUES ('HU','Hungary') ON CONFLICT DO NOTHING");
      const value=field==='active'?false:field==='country_code'?'HU':field==='latitude'?46.00001:23.00001;
      await db.query(`UPDATE localities SET ${field}=$2 WHERE id=$1`,[id,value]);
      const response=phase==='submission'?submit(key,1):decide(key,1);
      await response.expect(409,{error:field==='active'?'locality_unavailable':'locality_geography_changed'});
      expect(await state(key)).toEqual(before);
      if(phase==='approval')await decide(key,1,'request-changes').expect(200);
    }
  });
  it.each(['name','administrative_context','countryDisplayName'])('permits descriptive %s drift before submit and review while preserving saved JSON',async field=>{
    const id=await locality(); const key=await create(id);const original=(await state(key)).versions[0];
    for(const text of ['Before submit','After submit']){
      if(field==='countryDisplayName')await db.query("UPDATE countries SET display_name=$1 WHERE code='RO'",[text]);
      else await db.query(`UPDATE localities SET ${field}=$2 WHERE id=$1`,[id,text]);
      if(text==='Before submit')await submit(key,1).expect(200);
    }
    await decide(key,1).expect(200);expect((await state(key)).versions[0]).toEqual(original);
    const detail=(await inspect(key).expect(200)).body;expect(detail.localitySnapshot).toEqual(original.locality_snapshot);
    expect(detail.currentLocality[field==='administrative_context'?'administrativeContext':field]).toBe('After submit');
    await db.query("UPDATE countries SET display_name='Romania' WHERE code='RO'");
  });
  it('preserves one immutable suspension during replacement approval, reactivation and deletion attempts',async()=>{
    const key=await approved();await save(key,2).expect(201);await suspend(key,1).expect(200);
    const audit=(await state(key)).identity[0];await suspend(key,1).expect(409,{error:'template_eligibility_conflict'});
    await submit(key,2).expect(200);await decide(key,2).expect(200);
    expect((await state(key)).identity[0]).toMatchObject({local_approved_version:2,local_suspended_at:audit.local_suspended_at,local_suspended_version:1,local_suspension_reason:audit.local_suspension_reason});
    await db.query('UPDATE localities SET active=true WHERE id=$1',[place]);await save(key,3).expect(201);
    await request(app).delete(`${root}/${key}`).set('Authorization',auth()).expect(409);
    await post(`/api/admin/templates/${key}/reinstate`,{version:2},'admin').expect(404);
    await expect(db.query('DELETE FROM hunt_templates WHERE key=$1',[key])).rejects.toMatchObject({code:'23514'});
  });
  it('validates suspension input, stale authority, category gates and authoritative actor access',async()=>{
    const key=await approved(); const before=await state(key);
    for(const body of [{},{version:1,reason:''},{version:1,reason:' '.repeat(4)},{version:1,reason:'x'.repeat(1001)},{version:1,reason:'x',localApprovedVersion:2},{version:1.5,reason:'x'}])await post(`/api/admin/templates/${key}/suspend`,body,'admin').expect(400);
    await suspend(key,2).expect(409);
    for(const [role,status] of [['other',403],['guest',403],['blocked',401],['retired',401],['revoked',403],['organizer',403]] as const)await suspend(key,1,role).expect(status);
    await request(app).post(`/api/admin/templates/${key}/suspend`).send({version:1,reason:'x'}).expect(401);
    await suspend('missing',1).expect(404);await suspend('signal-cluj-napoca',1).expect(404);
    await suspend(await create(place,'universal'),1).expect(409);await suspend(await create(),1).expect(409);
    expect(await state(key)).toEqual(before);
  });
  it('retires a suspension-only actor, preserving the restrictive audit reference',async()=>{
    const key=await approved();await suspend(key,1,'secondAdmin').expect(200);
    await expect(db.query('DELETE FROM users WHERE id=$1',[actors.secondAdmin])).rejects.toMatchObject({code:'23503'});
    expect(await users.User.deleteControlled(actors.secondAdmin)).toBe('retired');
    expect((await state(key)).identity[0].local_suspended_by_user_id).toBe(actors.secondAdmin);
  });
  it('rejects SQL pointer clearing, regression, cross identity, category and immutable audit edits',async()=>{
    const key=await approved();const other=await approved();const otherVersion=(await state(other)).versions[0].version;
    for(const value of [null,0,2])await expect(db.query('UPDATE hunt_templates SET local_approved_version=$2 WHERE key=$1',[key,value])).rejects.toMatchObject({code:'23514'});
    await suspend(key,1).expect(200);
    for(const column of ['local_suspended_at','local_suspended_by_user_id','local_suspension_reason','local_suspended_version']){
      await expect(db.query(`UPDATE hunt_templates SET ${column}=NULL WHERE key=$1`,[key])).rejects.toMatchObject({code:'23514'});
    }
    const universal=await create(place,'universal');
    await expect(db.query('UPDATE hunt_templates SET local_approved_version=$2 WHERE key=$1',[universal,otherVersion])).rejects.toMatchObject({code:'23514'});
    const unapproved=await create();await expect(db.query('UPDATE hunt_templates SET local_approved_version=1 WHERE key=$1',[unapproved])).rejects.toMatchObject({code:'23514'});
    await expect(db.query('UPDATE hunt_templates SET local_suspended_at=now() WHERE key=$1',[unapproved])).rejects.toMatchObject({code:'23514'});
    const id=(await state(key)).identity[0].id;
    await expect(db.query("UPDATE hunt_template_reviews SET decision='changes_requested' WHERE template_id=$1",[id])).rejects.toMatchObject({code:'23514'});
    await expect(db.query('DELETE FROM hunt_template_reviews WHERE template_id=$1',[id])).rejects.toMatchObject({code:'23514'});
  });
  it('enforces composite version ownership and refuses regression to an independently approved older version',async()=>{
    const key=await approved();await save(key,2).expect(201);await submit(key,2).expect(200);await decide(key,2).expect(200);
    await expect(db.query('UPDATE hunt_templates SET local_approved_version=1 WHERE key=$1',[key])).rejects.toMatchObject({code:'23514'});
    const other=await create();const id=(await state(other)).identity[0].id;const client=await db.connect();
    try{
      await client.query('BEGIN');await client.query("UPDATE hunt_templates SET status='submitted',submitted_version=2 WHERE id=$1",[id]);
      // v2 exists only on the other Template; it must never satisfy this composite reference.
      await expect(client.query("UPDATE hunt_templates SET status='approved',local_approved_version=2 WHERE id=$1",[id])).rejects.toMatchObject({code:'23503'});
    }finally{await client.query('ROLLBACK');client.release();}
  });
  it('prevents inserting new historical approvals and deleting evidence-less historical authority through SQL',async()=>{
    await expect(db.query(`INSERT INTO hunt_templates (key,origin,category,created_by_user_id,status,submitted_version)
      VALUES ($1,'creator','local',$2,'approved',1)`,[`invented-${randomUUID()}`,actors.creator])).rejects.toMatchObject({code:'23514'});
    // This historical record still has no pointer/review and must nevertheless remain retained.
    await expect(db.query("DELETE FROM hunt_templates WHERE key='historical-inconsistent'")).rejects.toMatchObject({code:'23514'});
  });
  it('rejects newly invented approved evidence before any normal promotion',async()=>{
    const key=await create();const id=(await state(key)).identity[0].id;const before=await state(key);
    await expect(db.query("INSERT INTO hunt_template_reviews (template_id,version,reviewer_user_id,decision) VALUES ($1,1,$2,'approved')",[id,actors.admin])).rejects.toMatchObject({code:'23514'});
    await expect(db.query("UPDATE hunt_templates SET status='approved',submitted_version=1,local_approved_version=1 WHERE id=$1",[id])).rejects.toMatchObject({code:'23514'});
    expect(await state(key)).toEqual(before);
  });
  it.each(['missing','self','changes','nonadmin'])('defers exact independent %s evidence checks and rolls back SQL approval completely',async kind=>{
    const key=await create();await submit(key,1).expect(200);const before=await state(key);const id=before.identity[0].id;const client=await db.connect();
    try{
      await client.query('BEGIN');
      await client.query("UPDATE hunt_templates SET status='approved',local_approved_version=1 WHERE id=$1",[id]);
      if(kind!=='missing')await client.query('INSERT INTO hunt_template_reviews (template_id,version,reviewer_user_id,decision) VALUES ($1,1,$2,$3)',[id,kind==='self'?actors.creator:kind==='nonadmin'?actors.other:actors.admin,kind==='changes'?'changes_requested':'approved']);
      await expect(client.query('COMMIT')).rejects.toMatchObject({code:'23514'});
    }finally{await client.query('ROLLBACK');client.release();}
    expect(await state(key)).toEqual(before);
  });
  it('rejects insertion of approved evidence while the candidate is merely submitted',async()=>{
    const key=await create();const id=(await state(key)).identity[0].id;await submit(key,1).expect(200);const before=await state(key);
    await expect(db.query("INSERT INTO hunt_template_reviews (template_id,version,reviewer_user_id,decision) VALUES ($1,1,$2,'approved')",[id,actors.admin])).rejects.toMatchObject({code:'23514'});
    expect(await state(key)).toEqual(before);
  });
  it('keeps an initial changes-requested candidate without approval authority',async()=>{
    const key=await create();await submit(key,1).expect(200);await decide(key,1,'request-changes','creator').expect(200);
    expect((await get(`${root}/${key}`).expect(200)).body).toMatchObject({localApprovedVersion:null,localApproval:{authority:'none'}});
    await inspect(key).expect(409);await suspend(key,1).expect(409);
  });
  it.each(['approve-approve','approve-changes','approve-suspend','suspend-suspend','save-submit'])('serializes real concurrent %s transactions',async race=>{
    const key=await approved();
    if(race!=='suspend-suspend')await save(key,2).expect(201);
    if(race.startsWith('approve'))await submit(key,2).expect(200);
    const lock=await db.connect();let pending:Promise<any[]>|undefined;
    try{
      await lock.query('BEGIN');await lock.query('SELECT id FROM hunt_templates WHERE key=$1 FOR UPDATE',[key]);
      const actions=race==='approve-approve'?[decide(key,2),decide(key,2)]
        :race==='approve-changes'?[decide(key,2),decide(key,2,'request-changes')]
        :race==='approve-suspend'?[decide(key,2),suspend(key,1)]
        :race==='suspend-suspend'?[suspend(key,1),suspend(key,1)]
        :[save(key,3),submit(key,2)];
      pending=Promise.all(actions.map(p=>p.then(r=>r)));await blockedBy(lock);await lock.query('COMMIT');const results=await pending;
      if(race==='save-submit')expect([[201,409],[409,200]]).toContainEqual(results.map(r=>r.status));
      else if(race==='approve-suspend'){
        expect(results[0].status).toBe(200);expect([200,409]).toContain(results[1].status);
        const row=(await state(key)).identity[0];expect(row.local_approved_version).toBe(2);
        if(results[1].status===200)expect(row.local_suspended_version).toBe(1);
      }else expect(results.map(r=>r.status).sort()).toEqual([200,409]);
      const rows=(await state(key)).reviews;expect(new Set(rows.map(r=>r.version)).size).toBe(rows.length);
    }finally{await lock.query('ROLLBACK');lock.release();if(pending)await pending;}
  });
  it.each([true,false])('preserves exact authority and suspension with deterministic suspension-first=%s',async suspensionFirst=>{
    const key=await approved();await save(key,2).expect(201);await submit(key,2).expect(200);
    const client=await appPool.connect();const original=client.query.bind(client);
    let ready!:()=>void;const atCommit=new Promise<void>(resolve=>{ready=resolve;});
    let proceed!:()=>void;const releaseCommit=new Promise<void>(resolve=>{proceed=resolve;});
    const connect=vi.spyOn(appPool,'connect').mockImplementationOnce((async()=>client) as any);
    const intercepted=vi.spyOn(client,'query').mockImplementation((async(...args:any[])=>{
      if(args[0]==='COMMIT'){ready();await releaseCommit;}return(original as any)(...args);
    }) as any);
    let first:Promise<any>|undefined;let second:Promise<any>|undefined;
    try{
      first=suspensionFirst?model.HuntTemplates.suspendLocal(key,1,actors.admin,'Protect retained v1'):model.HuntTemplates.approveSubmittedCreator(key,actors.admin,2);
      await atCommit;second=(suspensionFirst?decide(key,2):suspend(key,1)).then(r=>r);
      await blockedBy(client);proceed();await first;const response=await second;
      expect(response.status).toBe(suspensionFirst?200:409);
      const row=(await state(key)).identity[0];expect(row.local_approved_version).toBe(2);
      expect(row.local_suspended_version).toBe(suspensionFirst?1:null);
    }finally{proceed();if(first)await first;if(second)await second;intercepted.mockRestore();connect.mockRestore();}
  });
  it.each(['active','latitude','longitude','country_code','name','administrative_context','countryDisplayName'])('rechecks %s after waiting for a catalog writer during approval',async field=>{
    const id=await locality();const key=await create(id);await submit(key,1).expect(200);
    const writer=await db.connect();let pending:Promise<any>|undefined;
    try{
      await writer.query('BEGIN');await writer.query("SELECT code FROM countries WHERE code='RO' FOR UPDATE");
      if(field==='country_code')await writer.query("INSERT INTO countries VALUES ('BG','Bulgaria') ON CONFLICT DO NOTHING");
      if(field==='countryDisplayName')await writer.query("UPDATE countries SET display_name='Text only' WHERE code='RO'");
      else await writer.query(`UPDATE localities SET ${field}=$2 WHERE id=$1`,[id,field==='active'?false:field==='country_code'?'BG':['latitude','longitude'].includes(field)?48:'Text only']);
      pending=decide(key,1).then(r=>r);await blockedBy(writer);await writer.query('COMMIT');const response=await pending;
      expect(response.status).toBe(['name','administrative_context','countryDisplayName'].includes(field)?200:409);
      expect((await state(key)).versions[0].locality_snapshot.name).toBe('Place');
    }finally{await writer.query('ROLLBACK');writer.release();if(pending)await pending;await db.query("UPDATE countries SET display_name='Romania' WHERE code='RO'");}
  });
  it.each(['submit','approve'].flatMap(operation=>['active','latitude','longitude','country_code','name','administrative_context','countryDisplayName'].map(field=>({operation,field}))))('holds catalog shared locks through $operation commit against $field writer',async ({operation,field})=>{
    const id=await locality();const key=await create(id);if(operation==='approve')await submit(key,1).expect(200);
    const client=await appPool.connect();const writer=await db.connect();const original=client.query.bind(client);
    let ready!:()=>void;const atCommit=new Promise<void>(resolve=>{ready=resolve;});
    let proceed!:()=>void;const releaseCommit=new Promise<void>(resolve=>{proceed=resolve;});
    const connect=vi.spyOn(appPool,'connect').mockImplementationOnce((async()=>client) as any);
    const intercepted=vi.spyOn(client,'query').mockImplementation((async(...args:any[])=>{if(args[0]==='COMMIT'){ready();await releaseCommit;}return(original as any)(...args);}) as any);
    let transition:Promise<any>|undefined;let writing:Promise<any>|undefined;
    try{
      transition=operation==='submit'?model.HuntTemplates.submitCreatorDraft(key,1,actors.creator):model.HuntTemplates.approveSubmittedCreator(key,actors.admin,1);
      await atCommit;await writer.query('BEGIN');await writer.query("SELECT code FROM countries WHERE code='RO' FOR SHARE");
      if(field==='country_code')await db.query("INSERT INTO countries VALUES ('BG','Bulgaria') ON CONFLICT DO NOTHING");
      writing=field==='countryDisplayName'?writer.query("UPDATE countries SET display_name='After commit' WHERE code='RO'")
        :writer.query(`UPDATE localities SET ${field}=$2 WHERE id=$1`,[id,field==='active'?false:field==='country_code'?'BG':['latitude','longitude'].includes(field)?48:'After commit']);
      await blockedBy(client);proceed();
      await transition;await writing;await writer.query('COMMIT');expect((await state(key)).versions[0].locality_snapshot.latitude).toBe(46);
      if(operation==='approve')expect((await state(key)).identity[0].local_approved_version).toBe(1);
    }finally{proceed();if(transition)await transition;if(writing)await writing;intercepted.mockRestore();connect.mockRestore();await writer.query('ROLLBACK');writer.release();await db.query("UPDATE countries SET display_name='Romania' WHERE code='RO'");}
  });
  it.each(['review','authority','audit','deferred'])('rolls back injected %s failure with intact authority and reusable pool',async stage=>{
    const key=await approved();if(stage!=='audit'){await save(key,2).expect(201);await submit(key,2).expect(200);}
    const before=await state(key);
    if(stage==='deferred')await db.query(`CREATE FUNCTION local_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.key='${key}' AND NEW.local_approved_version=2 THEN RAISE EXCEPTION 'injected deferred failure';END IF;RETURN NEW;END $$;
      CREATE CONSTRAINT TRIGGER local_fail_commit AFTER UPDATE ON hunt_templates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION local_fail_commit()`);
    const client=await appPool.connect();const original=client.query.bind(client);
    const connect=vi.spyOn(appPool,'connect').mockImplementationOnce((async()=>client) as any);
    const intercepted=vi.spyOn(client,'query').mockImplementation((async(...args:any[])=>{
      const result=await(original as any)(...args);const sql=String(args[0]);
      if((stage==='review'&&sql.includes('INSERT INTO hunt_template_reviews'))
        ||(stage==='authority'&&sql.includes("SET status = 'approved'"))
        ||(stage==='audit'&&sql.includes('SET local_suspended_at=now()')))throw new Error(`injected ${stage} failure`);
      return result;
    }) as any);
    try{await expect(stage==='audit'?model.HuntTemplates.suspendLocal(key,1,actors.admin,'Explicit decision'):model.HuntTemplates.approveSubmittedCreator(key,actors.admin,2)).rejects.toThrow('injected');}
    finally{intercepted.mockRestore();connect.mockRestore();if(stage==='deferred')await db.query('DROP TRIGGER local_fail_commit ON hunt_templates;DROP FUNCTION local_fail_commit()');}
    expect(await state(key)).toEqual(before);
    const reused=await appPool.connect();try{expect((await reused.query('SELECT 1 AS ok')).rows).toEqual([{ok:1}]);}finally{reused.release();}
  });
  it('keeps classified Organizer gates and historical Hunt snapshots unchanged',async()=>{
    const before=(await db.query('SELECT * FROM hunts ORDER BY id')).rows;
    const key=await approved();await suspend(key,1).expect(200);await save(key,2).expect(201);
    expect(await model.HuntTemplates.findApprovedByKeyWithLatestVersion(key)).toBeNull();
    expect((await model.HuntTemplates.listApprovedWithLatestVersion()).some(t=>t.key===key)).toBe(false);
    expect((await db.query('SELECT * FROM hunts ORDER BY id')).rows).toEqual(before);
    expect(before).toEqual(historicalHunts);
    expect(before).toHaveLength(1);
    expect((await db.query("SELECT category FROM hunt_templates WHERE key='signal-cluj-napoca'")).rows[0].category).toBeNull();
  });
});
