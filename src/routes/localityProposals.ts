import { Router, type ErrorRequestHandler } from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { LocalityProposals, ProposalError, type ProposalInput } from '../models/LocalityProposal.js';

const only = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).every(key => fields.includes(key));
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.trim().length >= min && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
const fields = ['countryCode','name','administrativeContext','latitude','longitude','explanation','evidenceReference'];
/**
 * @openapi
 * /api/geography/locality-proposals:
 *   post:
 *     tags: [Geography]
 *     summary: Submit a missing locality for independent Admin review (Creator only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [countryCode, name, administrativeContext, latitude, longitude, explanation, evidenceReference]
 *             properties:
 *               countryCode: { type: string, pattern: '^[A-Z]{2}$', description: Must exist in countries }
 *               name: { type: string, minLength: 1, maxLength: 200 }
 *               administrativeContext: { type: string, minLength: 1, maxLength: 200 }
 *               latitude: { type: number, minimum: -90, maximum: 90 }
 *               longitude: { type: number, minimum: -180, maximum: 180 }
 *               explanation: { type: string, minLength: 20, maxLength: 1000 }
 *               evidenceReference: { type: string, minLength: 20, maxLength: 1000, description: Independent source URL or retrievable citation supporting place and coordinates; Mapbox evidence forbidden }
 *     responses:
 *       201: { description: Complete pending proposal; no Locality created }
 *       400: { description: Invalid fields, unsupported country or restricted evidence }
 *       401: { description: Authentication required }
 *       403: { description: Active non-guest persisted Creator capability required }
 * /api/geography/locality-proposals/mine:
 *   get:
 *     tags: [Geography]
 *     summary: List own proposals and decisions, newest first (Creator only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Object containing proposals with submitted facts and decision metadata }
 *       401: { description: Authentication required }
 *       403: { description: Creator capability required }
 * /api/admin/locality-proposals:
 *   get:
 *     tags: [Geography]
 *     summary: List pending proposals with evidence, oldest first (persisted Admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Object containing proposals with full review information }
 *       401: { description: Authentication required }
 *       403: { description: Admin capability required }
 * /api/admin/locality-proposals/{id}/decision:
 *   post:
 *     tags: [Geography]
 *     summary: Independently approve or reject once; approval creates one Locality atomically
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
 *             required: [decision, reason]
 *             properties:
 *               decision: { type: string, enum: [approved, rejected] }
 *               reason: { type: string, minLength: 10, maxLength: 1000 }
 *     responses:
 *       200: { description: Complete final proposal including reviewer, reason, decidedAt and approved localityId }
 *       400: { description: Invalid input }
 *       401: { description: Authentication required }
 *       403: { description: Admin required or self-review forbidden }
 *       404: { description: Unknown proposal }
 *       409: { description: proposal_not_reviewable or locality_duplicate_conflict; duplicate remains pending for Admin resolution }
 */
export const localityProposalsRouter = Router();
localityProposalsRouter.use(requireAuth, requireRole('creator'));
localityProposalsRouter.post('/', async (req: AuthRequest, res, next) => {
  const body = req.body;
  if (!only(body, fields) || typeof body.countryCode !== 'string' || !/^[A-Z]{2}$/.test(body.countryCode)
    || !text(body.name, 1, 200) || !/[\p{L}\p{N}]/u.test(body.name)
    || !text(body.administrativeContext, 1, 200) || !text(body.explanation, 20, 1000)
    || !text(body.evidenceReference, 20, 1000) || /mapbox/i.test(body.evidenceReference) || /mapbox/i.test(body.explanation)
    || !/[\p{L}]{3}/u.test(body.evidenceReference)
    || typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90
    || typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const input = Object.fromEntries(Object.entries(body).map(([key,value]) => [key, typeof value === 'string' ? value.trim() : value])) as unknown as ProposalInput;
  try { return res.status(201).json(await LocalityProposals.submit(input, req.user!.id)); }
  catch (error) { return next(error); }
});
localityProposalsRouter.get('/mine', async (req: AuthRequest, res, next) => {
  try { return res.json({ proposals: await LocalityProposals.mine(req.user!.id) }); }
  catch (error) { return next(error); }
});

export const adminLocalityProposalsRouter = Router();
adminLocalityProposalsRouter.use(requireAuth, requireRole('admin'));
adminLocalityProposalsRouter.get('/', async (_req, res, next) => {
  try { return res.json({ proposals: await LocalityProposals.pending() }); }
  catch (error) { return next(error); }
});
adminLocalityProposalsRouter.post('/:id/decision', async (req: AuthRequest, res, next) => {
  const { id } = req.params;
  const body = req.body;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    || !only(body, ['decision','reason']) || !['approved','rejected'].includes(body.decision as string)
    || !text(body.reason, 10, 1000)) return res.status(400).json({ error: 'invalid_input' });
  try { return res.json(await LocalityProposals.decide(id, req.user!.id, body.decision as 'approved' | 'rejected', (body.reason as string).trim())); }
  catch (error) { return next(error); }
});
const proposalErrors: ErrorRequestHandler = (error, _req, res, next) => {
  if (error instanceof ProposalError) return res.status(error.status).json({ error: error.code });
  return next(error);
};
localityProposalsRouter.use(proposalErrors);
adminLocalityProposalsRouter.use(proposalErrors);
