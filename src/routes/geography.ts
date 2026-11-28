import { GeographicCatalog, CatalogError, normalizeCityName } from '../models/GeographicCatalog.js';
import { TokenBuckets } from '../middleware/abuseProtection.js';
import type { AuthRequest } from '../middleware/auth.js';
import { Router } from 'express';
import { requireAuth, requireAnyRole } from '../middleware/auth.js';
import { Geography } from '../models/Geography.js';

const router = Router();
router.use(requireAuth, requireAnyRole(['creator', 'organizer', 'admin']));

/**
 * @openapi
 * /api/geography/countries:
 *   get:
 *     tags: [Geography]
 *     summary: List stored country references (Creator, Organizer or Admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Object containing countries (code and displayName) }
 *       401: { description: Authentication required }
 *       403: { description: Professional capability required }
 * /api/geography/localities:
 *   get:
 *     tags: [Geography]
 *     summary: Search active stored localities; no external provider
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: q, required: true, schema: { type: string, minLength: 1, maxLength: 100 } }
 *     responses:
 *       200: { description: Up to 50 catalog records and providerStatus not_requested }
 *       400: { description: Invalid input or unsupported country/parameter }
 *       401: { description: Authentication required }
 *       403: { description: Professional capability required }
 * /api/geography/localities/{id}:
 *   get:
 *     tags: [Geography]
 *     summary: Resolve exact stored UUID, including inactive records
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Catalog fields including active flag; excludes internal provenance/provider metadata }
 *       400: { description: Invalid UUID }
 *       401: { description: Authentication required }
 *       403: { description: Professional capability required }
 *       404: { description: Locality not found }
 */
router.get('/countries', async (_req, res, next) => {
  try { return res.json({ countries: await Geography.countries() }); }
  catch (error) { return next(error); }
});

router.get('/localities', async (req, res, next) => {
  const { countryCode, q } = req.query;
  if (Object.keys(req.query).some(key => !['countryCode', 'q'].includes(key)) ||
      typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode) ||
      typeof q !== 'string' || q.trim().length < 1 || q.length > 100) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    if (!(await Geography.countries()).some(country => country.code === countryCode)) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    return res.json({ localities: await Geography.search(countryCode, q.trim()), providerStatus: 'not_requested' });
  } catch (error) { return next(error); }
});

router.get('/localities/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    const locality = await Geography.findById(id);
    return locality ? res.json(locality) : res.status(404).json({ error: 'not_found' });
  } catch (error) { return next(error); }
});

// Dedicated autocomplete budget; independent of disabled-by-default authentication budgets.
const catalogBuckets = new TokenBuckets(10000);
router.use(['/cities','/regions','/catalog-status'], (req: AuthRequest, res, next) => {
  res.setHeader('Cache-Control','private, no-store');
  const retry = catalogBuckets.consume(req.user!.id, { capacity: 120, windowMs: 60000 });
  if (retry) return res.setHeader('Retry-After',retry).status(429).json({error:'rate_limited'});
  next();
});
const geographicId = (id: unknown): id is string => typeof id === 'string' && /^[1-9]\d{0,14}$/.test(id);
const catalogFailure = (error: unknown, res: any, next: any) => error instanceof CatalogError
  ? res.status(error.status).json(error.code === 'catalog_not_imported'
    ? {error:error.code,catalogStatus:'not_imported',nextAction:'import_catalog'} : {error:error.code}) : next(error);

/**
 * @openapi
 * /api/geography/catalog-status:
 *   get:
 *     tags: [Geography]
 *     summary: Report committed catalog import readiness; never implies worldwide coverage or Template approval
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Ready only after a nonempty completed import and searchable city rows are committed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [source, status, nextAction]
 *               properties:
 *                 source: { type: string, enum: [geonames] }
 *                 status: { type: string, enum: [not_imported, ready] }
 *                 nextAction: { type: string, nullable: true, enum: [import_catalog, null] }
 *       400: { description: invalid_input }
 *       401: { description: Authentication required }
 *       403: { description: Professional capability required }
 *       429: { description: rate_limited }
 */
router.get('/catalog-status', async (req,res,next) => {
  if(Object.keys(req.query).length)return res.status(400).json({error:'invalid_input'});
  try{return res.json(await GeographicCatalog.status());}catch(error){return next(error);}
});

/**
 * @openapi
 * /api/geography/cities:
 *   get:
 *     tags: [Geography]
 *     summary: Search or browse the locally imported GeoNames populated-place catalog
 *     description: Country-scoped diacritic-insensitive literal prefix matching across primary and alternate names when q is given; without q, lists every city of admin1Code (region dropdown). Independent of Template inventory. Source ID keyset order. Attribution GeoNames (CC BY 4.0). No private approval data. The first page (no after) also returns registryLocalities - manual Localities from approved proposals that are not GeoNames cities - in the same shape with geographicId null and source registry.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: admin1Code, schema: { type: string, pattern: '^[A-Za-z0-9-]{1,40}$' }, description: Optional exact GeoNames admin1 identity from /regions, or unspecified for cities without admin1. Reset cursor when region changes. }
 *       - { in: query, name: admin2Code, schema: { type: string, pattern: '^[A-Za-z0-9-]{1,40}$' }, description: Optional subregion from /subregions (or unspecified for cities matching no official subdivision). Requires a concrete admin1Code. Omit to list the whole region. }
 *       - { in: query, name: q, schema: { type: string, minLength: 2, maxLength: 100 }, description: Required unless admin1Code is given }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { in: query, name: after, schema: { type: string, pattern: '^[1-9]\d{0,14}$' } }
 *     responses:
 *       200:
 *         description: Bounded city page; nextAfter is a source ID or null. Reset pagination when country/query changes.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [cities, registryLocalities, nextAfter]
 *               properties:
 *                 cities: { type: array, maxItems: 50, items: { $ref: '#/components/schemas/GeographicCity' } }
 *                 registryLocalities: { type: array, description: First page only; manual Localities in the same shape with geographicId null }
 *                 nextAfter: { type: string, nullable: true }
 *       400: { description: invalid_input; includes unsupported country and short/empty query }
 *       401: { description: Authentication required }
 *       403: { description: Creator, Organizer or Admin required }
 *       429: { description: rate_limited; Retry-After seconds }
 *       503: { description: catalog_not_imported; catalogStatus not_imported and nextAction import_catalog }
 * /api/geography/cities/{id}:
 *   get:
 *     tags: [Geography]
 *     summary: Resolve a stable GeoNames ID without registering or approving anything
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, pattern: '^[1-9]\d{0,14}$' } }]
 *     responses:
 *       200: { description: Catalog city, content: { application/json: { schema: { $ref: '#/components/schemas/GeographicCity' } } } }
 *       400: { description: invalid_input }
 *       401: { description: Authentication required }
 *       403: { description: Professional capability required }
 *       404: { description: not_found }
 *       429: { description: rate_limited }
 *       503: { description: catalog_not_imported; catalogStatus not_imported and nextAction import_catalog }
 * /api/geography/cities/{id}/resolve:
 *   post:
 *     tags: [Geography]
 *     summary: Creator or Admin selects a city; its Locality is linked or created automatically
 *     description: Empty JSON body. No Admin registration is required. An unlinked city is linked to its own GeoNames Locality or to the single exact same-place Locality, otherwise a new Locality is created (audited with the actor). Never approves a Template. An existing inactive Locality does not permit binding.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: The city with its Locality, content: { application/json: { schema: { $ref: '#/components/schemas/GeographicCity' } } } }
 *       400: { description: invalid_input }
 *       401: { description: Authentication required }
 *       403: { description: Creator or Admin required }
 *       404: { description: not_found }
 *       409: { description: catalog_changed }
 *       429: { description: rate_limited }
 *       503: { description: catalog_not_imported; catalogStatus not_imported and nextAction import_catalog }
 * components:
 *   schemas:
 *     GeographicCity:
 *       type: object
 *       properties:
 *         geographicId: { type: string, description: Stable GeoNames numeric source ID; never use as localityId }
 *         source: { type: string, enum: [geonames] }
 *         attribution: { type: string, enum: ['GeoNames (CC BY 4.0)'] }
 *         countryCode: { type: string }
 *         countryDisplayName: { type: string }
 *         name: { type: string }
 *         admin1Code: { type: string, description: Raw GeoNames admin1 code; empty or 00 means unspecified. Identity requires countryCode. }
 *         admin2Code: { type: string, description: Official admin2 subdivision code (with countryCode and admin1Code), or unspecified }
 *         subregionDisplayName: { type: string, nullable: true, description: Official admin2 label from admin2Codes; null when unspecified }
 *         regionDisplayName: { type: string, nullable: true, description: Authoritative admin1 dictionary label; never parsed from context }
 *         regionStatus: { type: string, enum: [resolved, missing_label, unspecified] }
 *         administrativeContext: { type: string }
 *         latitude: { type: number }
 *         longitude: { type: number }
 *         localityId: { type: string, format: uuid, nullable: true }
 *         registeredActive: { type: boolean }
 *         registrationState: { type: string, enum: [registered, registered_inactive, not_linked], description: not_linked cities are usable; selecting one (resolve) links or creates its Locality }
 *         nextAction: { type: string, enum: [bind_locality, resolve_city, unavailable] }
 *         hasApprovedLocalTemplate: { type: boolean, description: At least one currently C7-eligible public Local artifact; excludes private review/draft information and is advisory only }
 */
/**
 * @openapi
 * /api/geography/subregions:
 *   get:
 *     tags: [Geography]
 *     summary: Official admin2 subdivisions (county, district, commune, department...) of one region
 *     description: Optional level between region and city. Lists officially named admin2 records of the region, plus one admin2Code unspecified group when some cities or manual Localities of the region match none. An empty list means the region has no named subdivisions and clients skip the level. subregionLabel and regionLabel name both levels per country (e.g. RO County/Commune, US State/County, IN State/District, FR Region/Department; generic District/County).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: admin1Code, required: true, schema: { type: string, pattern: '^[A-Za-z0-9-]{1,40}$' } }
 *     responses:
 *       200: { description: subregions array of countryCode/admin1Code/admin2Code/displayName/labelStatus (resolved or unspecified), regionLabel, subregionLabel }
 *       400: { description: invalid_input }
 *       401: { description: Authentication required }
 *       403: { description: Creator, Organizer or Admin required }
 *       429: { description: rate_limited }
 *       503: { description: catalog_not_imported }
 * /api/geography/regions:
 *   get:
 *     tags: [Geography]
 *     summary: List imported GeoNames admin1 regions within a country
 *     description: Region identity is countryCode plus admin1Code. Labels come from admin1CodesASCII, independently of administrativeContext. metadataStatus incomplete means city codes lack dictionary labels; ready does not imply full country coverage. Empty regions with ready is a valid empty imported result. Codes without an official label are listed as "Region <code>"; cities and manual Localities without admin1 are grouped under admin1Code unspecified. regionLabel names the admin1 level per country (County for RO, State for US, ... Region by default; see domain/geographicRegions.ts).
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 50 } }
 *       - { in: query, name: after, schema: { type: string }, description: Opaque admin1Code cursor from nextAfter; reset on country change. }
 *     responses:
 *       200: { description: regions array of countryCode/admin1Code/displayName/source/attribution/labelStatus (resolved, missing_label or unspecified), nextAfter code or null, regionLabel, metadataStatus ready or incomplete }
 *       400: { description: invalid_input }
 *       401: { description: Authentication required }
 *       403: { description: Creator, Organizer or Admin required }
 *       429: { description: rate_limited }
 *       503: { description: catalog_not_imported }
 */
const admin1CodeValid = (value: unknown): value is string => typeof value==='string' && /^[A-Za-z0-9-]{1,40}$/.test(value) && value!=='00';
router.get('/regions', async(req,res,next)=>{
  const {countryCode,limit='50',after=''}=req.query;
  if(Object.keys(req.query).some(k=>!['countryCode','limit','after'].includes(k))
    || typeof countryCode!=='string' || !/^[A-Z]{2}$/.test(countryCode)
    || typeof limit!=='string' || !/^(?:[1-9]|[1-4]\d|50)$/.test(limit)
    || (after!=='' && !admin1CodeValid(after)))return res.status(400).json({error:'invalid_input'});
  try {
    if(!(await Geography.countries()).some(c=>c.code===countryCode))return res.status(400).json({error:'invalid_input'});
    return res.json(await GeographicCatalog.regions(countryCode,Number(limit),after as string));
  }catch(error){return catalogFailure(error,res,next);}
});
router.get('/subregions', async(req,res,next)=>{
  const {countryCode,admin1Code}=req.query;
  if(Object.keys(req.query).some(k=>!['countryCode','admin1Code'].includes(k))
    || typeof countryCode!=='string' || !/^[A-Z]{2}$/.test(countryCode) || !admin1CodeValid(admin1Code))return res.status(400).json({error:'invalid_input'});
  try {
    if(!(await Geography.countries()).some(c=>c.code===countryCode))return res.status(400).json({error:'invalid_input'});
    return res.json(await GeographicCatalog.subregions(countryCode,admin1Code));
  }catch(error){return catalogFailure(error,res,next);}
});
router.get('/cities', async (req, res, next) => {
  const {countryCode,q,admin1Code,admin2Code,limit='20',after='0'}=req.query;
  if(Object.keys(req.query).some(k=>!['countryCode','q','admin1Code','admin2Code','limit','after'].includes(k))
    || typeof countryCode!=='string' || !/^[A-Z]{2}$/.test(countryCode)
    || (admin1Code!==undefined && !admin1CodeValid(admin1Code))
    // A subregion narrows one concrete region.
    || (admin2Code!==undefined && (!admin1CodeValid(admin2Code) || admin1Code===undefined || admin1Code==='unspecified'))
    // Without q the request browses one region (dropdown); with q it searches names and aliases.
    || (q===undefined ? admin1Code===undefined : (typeof q!=='string' || q.length>100 || normalizeCityName(q).length<2))
    || typeof limit!=='string' || !/^(?:[1-9]|[1-4]\d|50)$/.test(limit)
    || typeof after!=='string' || (after!=='0' && !geographicId(after))) return res.status(400).json({error:'invalid_input'});
  try {
    if(!(await Geography.countries()).some(c=>c.code===countryCode))return res.status(400).json({error:'invalid_input'});
    return res.json(await GeographicCatalog.search(countryCode,q as string|undefined,Number(limit),after,admin1Code as string|undefined,admin2Code as string|undefined));
  }catch(error){return catalogFailure(error,res,next);}
});
router.get('/cities/:id', async(req,res,next)=>{
  if(!geographicId(req.params.id) || Object.keys(req.query).length)return res.status(400).json({error:'invalid_input'});
  try{return res.json(await GeographicCatalog.get(req.params.id));}catch(error){return catalogFailure(error,res,next);}
});
router.post('/cities/:id/resolve', requireAnyRole(['creator','admin']), async(req: AuthRequest,res,next)=>{
  if(!geographicId(req.params.id) || Object.keys(req.query).length || (req.body && (typeof req.body!=='object' || Array.isArray(req.body) || Object.keys(req.body).length)))return res.status(400).json({error:'invalid_input'});
  try{return res.json(await GeographicCatalog.resolve(req.params.id,req.user!.id));}catch(error){return catalogFailure(error,res,next);}
});

export const geographyRouter = router;
