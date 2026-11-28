import { Router } from 'express';
import { requireAuth, requireAnyRole, type AuthRequest } from '../middleware/auth.js';
import { TokenBuckets } from '../middleware/abuseProtection.js';
import { catalogCities, catalogRegions, catalogSubregions } from '../models/OrganizerGeography.js';
import { Geography } from '../models/Geography.js';
import { UNSPECIFIED_REGION, UNSPECIFIED_SUBREGION_LABEL, regionDisplayName, regionLabel, subregionLabel } from '../domain/geographicRegions.js';
import { LocalSelectionError } from '../models/OrganizerLocalTemplate.js';

export const organizerGeographyRouter = Router();
const router = organizerGeographyRouter;
const buckets = new TokenBuckets(10000);
router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();},requireAuth,requireAnyRole(['organizer']));
router.use((req:AuthRequest,res,next)=>{
  const retry=buckets.consume(req.user!.id,{capacity:120,windowMs:60000});
  if(retry)return res.set('Retry-After',String(retry)).status(429).json({error:'rate_limited'});
  next();
});
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
/**
 * @openapi
 * /api/organizer/geography/countries:
 *   get:
 *     tags: [Geography]
 *     summary: Stored countries independent of Local Hunt availability
 *     description: Organizer only; private no-store. Returns countries (countryCode, displayName) and opaque nextCursor. Full FE contract in docs/Organizer_Eligible_Geography.md.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200: { description: Catalog countries and nextCursor or null }
 *       400: { description: invalid_input }
 *       401: { description: unauthorized }
 *       403: { description: forbidden }
 *       429: { description: rate_limited }
 * /api/organizer/geography/regions:
 *   get:
 *     tags: [Geography]
 *     summary: Stored admin1 regions independent of Local Hunt availability
 *     description: Returns regions (regionId, countryCode, regionCode, label, labelStatus, level) and nextCursor. Missing metadata is explicit; no County inference.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200: { description: Catalog regions and nextCursor or null }
 *       400: { description: invalid_input }
 *       401: { description: unauthorized }
 *       403: { description: forbidden }
 *       429: { description: rate_limited }
 * /api/organizer/geography/subregions:
 *   get:
 *     tags: [Organizer Geography]
 *     summary: Optional admin2 level (county, district, commune...) of one region
 *     description: Organizer only; private no-store. Items have subregionId (regionId + ':admin2:<code>' or ':unspecified'), subregionCode, label, labelStatus (resolved or unspecified), level admin2 and levelLabel (e.g. RO Commune, US County, IN District, FR Department, otherwise District/County). Empty when the region has no named subdivisions.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string } }
 *       - { in: query, name: regionId, required: true, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200: { description: Subregions and nextCursor or null }
 *       400: { description: invalid_input }
 *       401: { description: unauthorized }
 *       403: { description: forbidden }
 *       429: { description: rate_limited }
 * /api/organizer/geography/cities:
 *   get:
 *     tags: [Geography]
 *     summary: Catalog cities in an exact region independent of Local Hunt availability
 *     description: Returns cities with geographicId, canonical localityId, countryCode, countryDisplayName, name, administrativeContext, regionId, regionCode, regionDisplayName, source, attribution; nextCursor is opaque or null.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: regionId, required: true, schema: { type: string } }
 *       - { in: query, name: subregionId, schema: { type: string }, description: Optional subregion from /subregions; omit for the whole region }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200: { description: Catalog cities (each with subregionId) and nextCursor or null }
 *       400: { description: invalid_input }
 *       401: { description: unauthorized }
 *       403: { description: forbidden }
 *       429: { description: rate_limited }
 */
router.get(['/countries','/regions','/subregions','/cities'],async(req,res,next)=>{
  try {
    const kind=req.path.split('/')[1].toLowerCase();
    const {countryCode,regionId,subregionId,limit='20',cursor}=req.query;
    const allowed=['limit','cursor',...(kind==='countries'?[]:['countryCode']),...(kind==='cities'||kind==='subregions'?['regionId']:[]),...(kind==='cities'?['subregionId']:[])];
    if(Object.keys(req.query).some(k=>!allowed.includes(k))
      || (kind!=='countries' && (typeof countryCode!=='string'||!/^[A-Z]{2}$/.test(countryCode)))
      || ((kind==='cities'||kind==='subregions') && (typeof regionId!=='string'||regionId.length>100||(!regionId.startsWith(`${countryCode}:`) || !/^[A-Z]{2}:(?:unknown|admin1:[A-Za-z0-9-]{1,40})$/.test(regionId))))
      // Optional subregion (cities only): one official subdivision of a concrete region, or its unspecified group.
      || (subregionId!==undefined && (typeof subregionId!=='string'||subregionId.length>200||!subregionId.startsWith(`${regionId}:`)
        || !/^[A-Z]{2}:admin1:[A-Za-z0-9-]{1,40}:(?:unspecified|admin2:[A-Za-z0-9-]{1,40})$/.test(subregionId)))
      || typeof limit!=='string'||!/^(?:[1-9]|[1-4]\d|50)$/.test(limit))throw new LocalSelectionError('invalid_input',400);
    const scope=JSON.stringify([kind,countryCode??null,regionId??null,subregionId??null]);
    let after:string|null=null;
    if(cursor!==undefined){
      try{
        if(typeof cursor!=='string'||cursor.length>1000||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();
        const decoded=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
        if(Object.keys(decoded).sort().join()!=='after,scope'||decoded.scope!==scope||typeof decoded.after!=='string'||decoded.after.length>100)throw Error();
        after=decoded.after;
      }catch{throw new LocalSelectionError('invalid_input',400);}
    }
    const region=(c:{countryCode:string;regionCode:string|null})=>`${c.countryCode}:${c.regionCode===null?'unknown':`admin1:${c.regionCode}`}`;
    const subregion=(regionKey:string,code:string|null|undefined)=>`${regionKey}:${code==null?'unspecified':`admin2:${code}`}`;
    const items=new Map<string,object>();
    if(kind==='countries') {
      for(const c of await Geography.countries())items.set(c.code,{countryCode:c.code,displayName:c.displayName});
    } else if(kind==='regions') {
      for(const c of await catalogRegions(countryCode as string))items.set(region(c),{regionId:region(c),countryCode:c.countryCode,regionCode:c.regionCode,
        label:regionDisplayName(c.regionCode ?? UNSPECIFIED_REGION,c.regionDisplayName),labelStatus:c.regionCode===null?'unspecified':c.regionDisplayName===null?'missing_label':'resolved',
        level:'admin1',levelLabel:regionLabel(c.countryCode)});
    } else if(kind==='subregions') {
      const regionCode=(regionId as string).startsWith(`${countryCode}:admin1:`)?(regionId as string).slice(`${countryCode}:admin1:`.length):null;
      if(regionCode!==null)for(const c of await catalogSubregions(countryCode as string,regionCode))
        items.set(subregion(regionId as string,c.subregionCode),{subregionId:subregion(regionId as string,c.subregionCode),regionId,
          subregionCode:c.subregionCode,label:c.subregionCode===null?UNSPECIFIED_SUBREGION_LABEL:c.subregionDisplayName,
          labelStatus:c.subregionCode===null?'unspecified':'resolved',level:'admin2',levelLabel:subregionLabel(countryCode as string)});
    } else {
      for(const c of await catalogCities(countryCode as string))if(region(c)===regionId && (subregionId===undefined || subregion(region(c),c.subregionCode)===subregionId)){
        // Manual Localities have no GeoNames ID; their stable key is the Locality UUID.
        const registry=c.source==='registry';
        items.set(registry?`registry:${c.localityId}`:c.geographicId!,{...c,regionId:region(c),subregionId:subregion(region(c),c.subregionCode),source:registry?'registry':'geonames',attribution:registry?null:'GeoNames (CC BY 4.0)'});
      }
    }
    const sorted=[...items].sort(([a],[b])=>compare(a,b)).filter(([id])=>after===null||compare(id,after)>0);
    const page=sorted.slice(0,Number(limit));
    res.json({[kind]:page.map(([,value])=>value),nextCursor:sorted.length>Number(limit)
      ?Buffer.from(JSON.stringify({scope,after:page.at(-1)![0]})).toString('base64url'):null});
  }catch(error){if(error instanceof LocalSelectionError)return res.status(error.status).json({error:error.code});next(error);}
});
