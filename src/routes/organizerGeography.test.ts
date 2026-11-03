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
  return {localityId,geographicId:id,countryCode,countryDisplayName:countryCode,name:'Same city',administrativeContext:'County',regionCode,regionDisplayName:null};
}
beforeEach(()=>{
  vi.clearAllMocks();
  vi.mocked(User.findById).mockResolvedValue({id:'actor',roles:['organizer'],isGuest:false,accountStatus:'active'} as any);
  vi.mocked(pool.query).mockResolvedValue({rows:[]} as never);
});
describe('Organizer catalog geography',()=>{
  it('discovers catalog cities without reading approval or Hunt inventory',async()=>{
    const city=row('681290');
    vi.mocked(pool.query).mockResolvedValue({rows:[city]} as never);
    const r=await get('/cities?countryCode=RO&regionId=RO:admin1:13&limit=1').expect(200);
    expect(r.body).toEqual({cities:[{...city,regionId:'RO:admin1:13',source:'geonames',attribution:'GeoNames (CC BY 4.0)'}],nextCursor:null});
    expect(r.headers['cache-control']).toBe('private, no-store');
    const sql=vi.mocked(pool.query).mock.calls[0][0];
    expect(sql).toContain('FROM geographic_cities');expect(sql).not.toMatch(/hunt_templates|hunt_template_versions|hunt_template_reviews|FROM hunts/);
  });
  it('includes unregistered catalog cities with an explicit null canonical locality',async()=>{
    vi.mocked(pool.query).mockResolvedValue({rows:[{...row('681290'),localityId:null}]} as never);
    expect((await get('/cities?countryCode=RO&regionId=RO:admin1:13').expect(200)).body.cities[0].localityId).toBeNull();
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
  it('returns stored countries without Hunt inventory and walks scoped cursors without duplicates',async()=>{
    vi.mocked(pool.query).mockResolvedValue({rows:[{code:'RO',displayName:'RO'},{code:'HU',displayName:'HU'}]} as never);
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
    vi.mocked(pool.query).mockResolvedValue({rows:[{code:'RO',displayName:'Romania'}]} as never);
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
