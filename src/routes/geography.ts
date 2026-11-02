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
const uuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
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
 *     summary: Search the locally imported GeoNames populated-place catalog
 *     description: Country-scoped diacritic-insensitive literal prefix matching across primary and alternate names. Independent of Template inventory. Source ID keyset order. Attribution GeoNames (CC BY 4.0). No private approval data.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: admin1Code, schema: { type: string, pattern: '^[A-Za-z0-9-]{1,40}$' }, description: Optional exact GeoNames admin1 identity; requires a stored authoritative region label. Reset cursor when region changes. }
 *       - { in: query, name: q, required: true, schema: { type: string, minLength: 2, maxLength: 100 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { in: query, name: after, schema: { type: string, pattern: '^[1-9]\d{0,14}$' } }
 *     responses:
 *       200:
 *         description: Bounded city page; nextAfter is a source ID or null. Reset pagination when country/query changes.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [cities, nextAfter]
 *               properties:
 *                 cities: { type: array, maxItems: 50, items: { $ref: '#/components/schemas/GeographicCity' } }
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
 *     summary: Creator or Admin explicitly selects a city; reuse an exact unambiguous canonical locality
 *     description: Empty JSON body. Never creates a locality or approves a Template. Missing/ambiguous registration returns an explicit state and next action. Existing inactive locality does not permit binding.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: GeographicCity when mapped; otherwise geographicId, null localityId, registrationState registration_required or reconciliation_required and nextAction request_registration or contact_admin }
 *       400: { description: invalid_input }
 *       401: { description: Authentication required }
 *       403: { description: Creator or Admin required }
 *       404: { description: not_found }
 *       409: { description: catalog_changed or reconciliation_required }
 *       429: { description: rate_limited }
 *       503: { description: catalog_not_imported; catalogStatus not_imported and nextAction import_catalog }
 * /api/geography/cities/{id}/registration:
 *   post:
 *     tags: [Geography]
 *     summary: Admin reconciles a catalog city to an existing UUID or explicitly registers it
 *     description: Registration does not approve Templates or confer Organizer eligibility. Creation is blocked by any same-name/alias or source-ID candidate. Explicit reconciliation retains the existing UUID and coordinates.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [reason]
 *             properties:
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *               localityId: { type: string, format: uuid }
 *               create: { type: boolean, enum: [true] }
 *             oneOf:
 *               - { required: [localityId] }
 *               - { required: [create] }
 *     responses:
 *       200: { description: Registered city, content: { application/json: { schema: { $ref: '#/components/schemas/GeographicCity' } } } }
 *       400: { description: invalid_input }
 *       401: { description: Authentication required }
 *       403: { description: Admin required }
 *       404: { description: not_found }
 *       409: { description: reconciliation_required, already_registered, country_locality_mismatch or catalog_changed }
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
 *         regionDisplayName: { type: string, nullable: true, description: Authoritative admin1 dictionary label; never parsed from context }
 *         regionStatus: { type: string, enum: [resolved, missing_label, unspecified] }
 *         administrativeContext: { type: string }
 *         latitude: { type: number }
 *         longitude: { type: number }
 *         localityId: { type: string, format: uuid, nullable: true }
 *         registeredActive: { type: boolean }
 *         registrationState: { type: string, enum: [registered, registered_inactive, registration_required] }
 *         nextAction: { type: string, enum: [bind_locality, contact_admin, request_registration] }
 *         hasApprovedLocalTemplate: { type: boolean, description: At least one currently C7-eligible public Local artifact; excludes private review/draft information and is advisory only }
 */
/**
 * @openapi
 * /api/geography/regions:
 *   get:
 *     tags: [Geography]
 *     summary: List imported GeoNames admin1 regions within a country
 *     description: Region identity is countryCode plus admin1Code. Labels come from admin1CodesASCII, independently of administrativeContext. metadataStatus incomplete means city codes lack dictionary labels; ready does not imply full country coverage. Empty regions with ready is a valid empty imported result. Region label is County for RO and State / Region elsewhere.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 50 } }
 *       - { in: query, name: after, schema: { type: string }, description: Opaque admin1Code cursor from nextAfter; reset on country change. }
 *     responses:
 *       200: { description: regions array of countryCode/admin1Code/displayName/source/attribution, nextAfter code or null, regionLabel, metadataStatus ready or incomplete }
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
router.get('/cities', async (req, res, next) => {
  const {countryCode,q,admin1Code,limit='20',after='0'}=req.query;
  if(Object.keys(req.query).some(k=>!['countryCode','q','admin1Code','limit','after'].includes(k))
    || typeof countryCode!=='string' || !/^[A-Z]{2}$/.test(countryCode)
    || (admin1Code!==undefined && !admin1CodeValid(admin1Code))
    || typeof q!=='string' || q.length>100 || normalizeCityName(q).length<2
    || typeof limit!=='string' || !/^(?:[1-9]|[1-4]\d|50)$/.test(limit)
    || typeof after!=='string' || (after!=='0' && !geographicId(after))) return res.status(400).json({error:'invalid_input'});
  try {
    if(!(await Geography.countries()).some(c=>c.code===countryCode))return res.status(400).json({error:'invalid_input'});
    return res.json(await GeographicCatalog.search(countryCode,q,Number(limit),after,admin1Code as string|undefined));
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
router.post('/cities/:id/registration', requireAnyRole(['admin']), async(req: AuthRequest,res,next)=>{
  const b=req.body;
  if(!geographicId(req.params.id) || Object.keys(req.query).length || !b || typeof b!=='object' || Array.isArray(b)
    || Object.keys(b).some(k=>!['localityId','create','reason'].includes(k))
    || typeof b.reason!=='string' || !b.reason.trim() || b.reason.length>1000
    || !((uuid(b.localityId) && b.create===undefined) || (b.create===true && b.localityId===undefined))) return res.status(400).json({error:'invalid_input'});
  try{return res.json(await GeographicCatalog.resolve(req.params.id,req.user!.id,{...b,reason:b.reason.trim()}));}catch(error){return catalogFailure(error,res,next);}
});

export const geographyRouter = router;
