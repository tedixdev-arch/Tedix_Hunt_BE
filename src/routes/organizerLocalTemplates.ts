import { Router, type RequestHandler } from 'express';
import { requireAuth, requireAnyRole, type AuthRequest } from '../middleware/auth.js';
import { artifactMetadata, discoverLocalArtifacts, LocalSelectionError, selectLocalTemplate } from '../models/OrganizerLocalTemplate.js';
import { projectTemplateGeography } from '../domain/huntTemplates.js';

export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const country = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{2}$/.test(v);
const version = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const noStore: RequestHandler = (_req,res,next) => { res.set('Cache-Control','private, no-store'); next(); };
const router = Router();
router.use(noStore,requireAuth,requireAnyRole(['organizer']));

/**
 * @openapi
 * /api/organizer/local-templates:
 *   get:
 *     tags: [Hunt Templates]
 *     summary: Discover eligible exact approved Local Templates
 *     description: Requires active non-guest Organizer capability. Required Country and Locality UUID filters; live advisory inventory. Private no-store; no gameplay answers or private review data. Version fields are internal selection references.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: localityId, required: true, schema: { type: string, format: uuid } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 20 } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *     responses:
 *       200: { description: templates metadata array and opaque nextCursor or null, ordered by key then templateId }
 *       400: { description: invalid_input; malformed or unsupported filters or cursor }
 *       401: { description: unauthorized }
 *       403: { description: forbidden }
 *       404: { description: not_found; unknown or wrong-country Locality }
 *       409: { description: locality_unavailable }
 * /api/organizer/local-templates/{templateId}/versions/{version}:
 *   get:
 *     tags: [Hunt Templates]
 *     summary: Preview the exact currently eligible Local approval
 *     description: Same Country/Locality context and Organizer policy as discovery. Returns saved localitySnapshot, separate currentLocality, and only the nested allowlisted geographic configuration. Ineligible, missing and stale versions are indistinguishable.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: templateId, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: version, required: true, schema: { type: integer, minimum: 1, maximum: 2147483647 } }
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: localityId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Exact authority metadata, geographic configuration and currentLocality }
 *       400: { description: invalid_input }
 *       401: { description: unauthorized }
 *       403: { description: forbidden }
 *       404: { description: not_found }
 *       409: { description: locality_unavailable }
 * /api/hunts/{id}/local-template:
 *   put:
 *     tags: [Hunts]
 *     summary: Atomically capture an exact approved Local source into a draft Hunt
 *     description: Requires persisted active Organizer capability and Hunt-specific organizer authority. Locks and revalidates approval, suspension and material catalog facts; preserves all Hunt settings. Never accepts client snapshots or substitutes a newer version. Conflicts leave the Hunt unchanged; refresh choices and explicitly reselect after a stale selection.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [templateId, version, countryCode, localityId]
 *             properties:
 *               templateId: { type: string, format: uuid }
 *               version: { type: integer, minimum: 1, maximum: 2147483647 }
 *               countryCode: { type: string, pattern: '^[A-Z]{2}$' }
 *               localityId: { type: string, format: uuid }
 *     responses:
 *       200: { description: Authorized Hunt with additive templateId, templateLocalityId and templateLocalitySnapshot }
 *       400: { description: invalid_input }
 *       401: { description: unauthorized }
 *       403: { description: forbidden before source lookup }
 *       404: { description: not_found; unknown Hunt }
 *       409: { description: invalid_hunt_state, template_not_eligible, template_selection_stale, locality_unavailable or locality_geography_changed }
 */
router.get(['/', '/:templateId/versions/:version'],async (req,res,next) => {
  try {
    const detail = req.params.templateId !== undefined;
    const {countryCode,localityId,limit,cursor} = req.query;
    const allowed = detail ? ['countryCode','localityId'] : ['countryCode','localityId','limit','cursor'];
    if (Object.keys(req.query).some(k => !allowed.includes(k)) || !country(countryCode) || !uuid(localityId)
      || (detail && (!uuid(req.params.templateId) || !/^[1-9]\d*$/.test(String(req.params.version)) || !version(Number(req.params.version))))
      || (!detail && limit !== undefined && (typeof limit !== 'string' || !/^[1-9]\d*$/.test(limit) || Number(limit)>50)))
      throw new LocalSelectionError('invalid_input',400);
    let after: {key:string;templateId:string} | null = null;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
        const decoded = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
        if (decoded.countryCode !== countryCode || decoded.localityId !== localityId.toLowerCase()
          || typeof decoded.key !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(decoded.key)
          || decoded.key.length>100 || !uuid(decoded.templateId)
          || Object.keys(decoded).sort().join() !== 'countryCode,key,localityId,templateId') throw Error();
        after = decoded;
      } catch { throw new LocalSelectionError('invalid_input',400); }
    }
    let artifacts = await discoverLocalArtifacts(countryCode,localityId.toLowerCase());
    if (detail) {
      const artifact = artifacts.find(a => a.templateId === String(req.params.templateId).toLowerCase() && a.version === Number(req.params.version));
      if (!artifact) throw new LocalSelectionError('not_found',404);
      return res.json({...artifactMetadata(artifact),configuration:projectTemplateGeography(artifact.content),currentLocality:artifact.currentLocality});
    }
    if (after) artifacts = artifacts.filter(a => a.key > after!.key || (a.key === after!.key && a.templateId > after!.templateId));
    const size = limit === undefined ? 20 : Number(limit);
    const page = artifacts.slice(0,size);
    const last = page.at(-1);
    return res.json({templates:page.map(artifactMetadata),nextCursor:artifacts.length>size && last
      ? Buffer.from(JSON.stringify({countryCode,localityId:localityId.toLowerCase(),key:last.key,templateId:last.templateId})).toString('base64url') : null});
  } catch(error) { if (error instanceof LocalSelectionError) return res.status(error.status).json({error:error.code}); next(error); }
});

export const organizerLocalTemplatesRouter = router;
export const huntLocalTemplateRouter = Router({mergeParams:true});
huntLocalTemplateRouter.use(noStore);
huntLocalTemplateRouter.put('/',requireAuth,requireAnyRole(['organizer']),async(req: AuthRequest,res,next) => {
  const body = req.body;
  if (Object.keys(req.query).length || !uuid(req.params.id) || !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join() !== 'countryCode,localityId,templateId,version'
    || !uuid(body.templateId) || !uuid(body.localityId) || !version(body.version) || !country(body.countryCode))
    return res.status(400).json({error:'invalid_input'});
  try { res.json(await selectLocalTemplate(String(req.params.id),req.user!.id,body)); }
  catch(error) { if (error instanceof LocalSelectionError) return res.status(error.status).json({error:error.code}); next(error); }
});
