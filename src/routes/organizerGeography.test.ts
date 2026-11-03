import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/postgres.js',()=>({pool:{query:vi.fn()}}));
vi.mock('../models/User.js',()=>({User:{findById:vi.fn()}}));
import { pool } from '../lib/postgres.js';
import { User } from '../models/User.js';
import { signJwt } from '../lib/jwt.js';
import { organizerGeographyRouter } from './organizerGeography.js';
const app=express();app.use('/api/organizer/geography',organizerGeographyRouter);
const auth=`Bearer ${signJwt({sub:'actor',type:'access'})}`;
const root='/api/organizer/geography';
const get=(path:string)=>request(app).get(root+path).set('Authorization',auth);
function row(id='1',countryCode='RO',regionCode:string|null='13') {
  const localityId=`00000000-0000-0000-0000-${id.padStart(12,'0')}`;
  const snapshot={id:localityId,countryCode,countryDisplayName:countryCode,name:'Same city',administrativeContext:'County',latitude:46,longitude:23};
  return {templateId:localityId,key:'local-test',version:1,origin:'creator',category:'local',created_by_user_id:'owner',
    version_origin:'creator',version_category:'local',version_owner:'owner',local_suspended_at:null,decision:'approved',reviewer_user_id:'reviewer',
    localityId,localitySnapshot:snapshot,currentLocality:{...snapshot,active:true},geographicId:id,regionCode,catalogName:'Same city',catalogContext:'County',
    content:{key:'local-test',version:1,displayName:'Local',theme:'Explore',mission:{name:'Find'},scoring:{startingScore:100},
      configuration:{normalCheckpointCount:1,checkpointPositions:[{checkpointNumber:1,name:'Start',latitude:46,longitude:23,radiusMeters:25}],
        finishPoint:{name:'End',latitude:46,longitude:23,radiusMeters:25}},checkpoints:[{checkpoint:1},{role:'terminal',navigationMode:'none'}]}};
}
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(User.findById).mockResolvedValue({id:'actor',roles:['organizer'],isGuest:false,accountStatus:'active'} as any);
  vi.mocked(pool.query).mockResolvedValue({rows:[]} as never);
});
describe('Organizer eligible geography',()=>{
  it('filters with C7 before grouping/pagination and deduplicates exact localities',async()=>{
    const valid=row('9');
    const bad=[{...row('1'),local_suspended_at:'now'},{...row('2'),decision:'pending'},
      {...row('3'),currentLocality:{...row('3').currentLocality,active:false}},
      {...row('4'),localitySnapshot:{...row('4').localitySnapshot,countryCode:'HU'}},
      {...row('5'),content:{}},{...row('6'),version_owner:'other'}];
    vi.mocked(pool.query).mockResolvedValue({rows:[...bad,valid,valid]} as never);
    const r=await get('/cities?countryCode=RO&regionId=RO:admin1:13&limit=1').expect(200);
    expect(r.body.cities).toHaveLength(1);expect(r.body.cities[0]).toMatchObject({geographicId:'9',localityId:valid.localityId});expect(r.body.nextCursor).toBeNull();
    expect(r.headers['cache-control']).toBe('private, no-store');
    const sql=vi.mocked(pool.query).mock.calls[0][0];expect(sql).not.toMatch(/LIMIT/i);expect(sql).toContain('g.locality_id=a."localityId"');
  });
  it('scopes country at the database boundary and region by code, never city names',async()=>{
    vi.mocked(pool.query).mockResolvedValue({rows:[row('1','RO','13'),row('2','RO','14')]} as never);
    const r=await get('/cities?countryCode=RO&regionId=RO:admin1:14').expect(200);
    expect(r.body.cities.map((c:any)=>c.geographicId)).toEqual(['2']);
    expect(vi.mocked(pool.query).mock.calls[0][1]).toEqual(['RO']);
    await get('/cities?countryCode=RO&regionId=HU:admin1:14').expect(400);
  });
  it('handles missing metadata explicitly and uses authoritative labels',async()=>{
    vi.mocked(pool.query).mockResolvedValue({rows:[row('1','RO',null),row('2'),{...row('3','RO','14'),regionDisplayName:'Cluj'}]} as never);
    const r=await get('/regions?countryCode=RO').expect(200);
    expect(r.body.regions).toEqual(expect.arrayContaining([
      expect.objectContaining({regionId:'RO:unknown',regionCode:null,labelStatus:'unspecified'}),
      expect.objectContaining({regionId:'RO:admin1:13',label:'13',labelStatus:'missing_label'}),
      expect.objectContaining({regionId:'RO:admin1:14',label:'Cluj',labelStatus:'resolved'})]));
    expect((await get('/cities?countryCode=RO&regionId=RO:unknown')).body.cities).toHaveLength(1);
  });
  it('returns countries only with eligible inventory and walks scoped cursors without duplicates',async()=>{
    vi.mocked(pool.query).mockResolvedValue({rows:[row('1','RO'),row('2','HU'),row('3','RO'),{...row('4','FR'),decision:'pending'}]} as never);
    const first=await get('/countries?limit=1').expect(200);expect(first.body.countries).toEqual([{countryCode:'HU',displayName:'HU'}]);
    const last=await get(`/countries?limit=1&cursor=${first.body.nextCursor}`).expect(200);
    expect(last.body.countries).toEqual([{countryCode:'RO',displayName:'RO'}]);expect(last.body.nextCursor).toBeNull();
    await get(`/regions?countryCode=RO&cursor=${first.body.nextCursor}`).expect(400);
  });
  it('paginates cities and regions with cursors bound to their exact filters',async()=>{
    vi.mocked(pool.query).mockResolvedValue({rows:[row('1'),row('2'),row('3','RO','14')]} as never);
    const first=await get('/cities?countryCode=RO&regionId=RO:admin1:13&limit=1').expect(200);
    expect(first.body.cities[0].geographicId).toBe('1');
    const last=await get(`/cities?countryCode=RO&regionId=RO:admin1:13&limit=1&cursor=${first.body.nextCursor}`).expect(200);
    expect(last.body.cities[0].geographicId).toBe('2');expect(last.body.nextCursor).toBeNull();
    await get(`/cities?countryCode=RO&regionId=RO:admin1:14&cursor=${first.body.nextCursor}`).expect(400);
    const regions=await get('/regions?countryCode=RO&limit=1').expect(200);
    expect(regions.body.regions[0].regionCode).toBe('13');
    const next=await get(`/regions?countryCode=RO&limit=1&cursor=${regions.body.nextCursor}`).expect(200);
    expect(next.body.regions[0].regionCode).toBe('14');expect(next.body.nextCursor).toBeNull();
    expect((await get('/countries/').expect(200)).body.countries).toHaveLength(1);
  });
  it.each(['/countries','/regions?countryCode=RO','/cities?countryCode=RO&regionId=RO:admin1:13'])('returns empty %s',async path=>{
    const r=await get(path).expect(200);expect(r.body.nextCursor).toBeNull();expect(Object.values(r.body)).toContainEqual([]);
  });
  it.each(['/countries?countryCode=RO','/regions','/cities?countryCode=RO','/countries?limit=51','/countries?cursor=bad'])('rejects invalid query %s',async path=>{await get(path).expect(400);expect(pool.query).not.toHaveBeenCalled();});
  it('rate limits Organizer geography with no-store and Retry-After',async()=>{
    vi.mocked(User.findById).mockResolvedValue({id:'budget-actor',roles:['organizer'],isGuest:false,accountStatus:'active'} as any);
    for(let n=0;n<120;n++)await get('/countries').expect(200);
    const r=await get('/countries').expect(429);expect(r.headers['retry-after']).toBeDefined();expect(r.headers['cache-control']).toBe('private, no-store');
  });
  it('applies persisted authentication/capabilities before inventory lookup',async()=>{
    await request(app).get(root+'/countries').expect(401);
    for(const user of [{roles:['creator']},{roles:['admin']},{roles:['organizer'],isGuest:true},{roles:['organizer'],accountStatus:'blocked'}]){
      vi.mocked(User.findById).mockResolvedValue({id:'actor',isGuest:false,accountStatus:'active',...user} as any);
      const r=await get('/countries').expect(user.accountStatus==='blocked'?401:403);expect(r.headers['cache-control']).toBe('private, no-store');
    }
    expect(pool.query).not.toHaveBeenCalled();
  });
});
