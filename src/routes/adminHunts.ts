import express, { type NextFunction, type Response } from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { AdminHuntError, AdminHunts, HUNT_STATUSES, SORTS, type AdminHuntFilter, type AdminHuntSort } from '../models/AdminHunt.js';
import { Hunt, type HuntStatus } from '../models/Hunt.js';
import { isLifecycleAction } from '../domain/huntLifecycle.js';

/**
 * @openapi
 * /api/admin/hunts:
 *   get:
 *     tags: [Admin Hunts]
 *     security: [{ bearerAuth: [] }]
 *     summary: Paginated Hunts across all organizations with search, filters and sorting
 *     parameters:
 *       - { in: query, name: q, schema: { type: string, maxLength: 120 }, description: 'Hunt, organization, organizer name/email, city or country' }
 *       - { in: query, name: status, schema: { type: string, enum: [draft, published, active, paused, cancelled, finished] } }
 *       - { in: query, name: organizationId, schema: { type: string, format: uuid } }
 *       - { in: query, name: organizerId, schema: { type: string, format: uuid } }
 *       - { in: query, name: city, schema: { type: string } }
 *       - { in: query, name: country, schema: { type: string } }
 *       - { in: query, name: startFrom, schema: { type: string, format: date } }
 *       - { in: query, name: startTo, schema: { type: string, format: date } }
 *       - { in: query, name: createdFrom, schema: { type: string, format: date } }
 *       - { in: query, name: createdTo, schema: { type: string, format: date } }
 *       - { in: query, name: sort, schema: { type: string, enum: [created, start, name, status], default: created } }
 *       - { in: query, name: order, schema: { type: string, enum: [asc, desc], default: desc } }
 *       - { in: query, name: page, schema: { type: integer, minimum: 1, default: 1 } }
 *       - { in: query, name: pageSize, schema: { type: integer, enum: [10, 25, 50, 100], default: 25 } }
 *     responses: { 200: { description: '{ hunts, total, page, pageSize }' }, 400: { description: invalid_input } }
 * /api/admin/hunts/filters:
 *   get:
 *     tags: [Admin Hunts]
 *     security: [{ bearerAuth: [] }]
 *     summary: Organizations and organizers that own Hunts, for filter menus
 *     responses: { 200: { description: '{ organizations, organizers }' } }
 * /api/admin/hunts/export:
 *   get:
 *     tags: [Admin Hunts]
 *     security: [{ bearerAuth: [] }]
 *     summary: CSV export of the Hunts matching the same filters as the list (max 10 000 rows)
 *     responses: { 200: { description: '{ filename, csv, rows, truncated }' } }
 * /api/admin/hunts/{id}:
 *   get:
 *     tags: [Admin Hunts]
 *     security: [{ bearerAuth: [] }]
 *     summary: Complete Hunt record for Admins, including access code, organizer, counts, lifecycle timestamps and publish readiness
 *     responses: { 200: { description: Hunt detail }, 404: { description: not_found } }
 * /api/admin/hunts/{id}/history:
 *   get:
 *     tags: [Admin Hunts]
 *     security: [{ bearerAuth: [] }]
 *     summary: Audit events for this Hunt (lifecycle, Admin overrides, configuration and safety actions), newest first
 *     responses: { 200: { description: '{ events }' } }
 * /api/admin/hunts/{id}/access:
 *   post:
 *     tags: [Admin Hunts]
 *     security: [{ bearerAuth: [] }]
 *     summary: Create (or return) the participant access code of a published, active or paused Hunt
 *     responses: { 200: { description: '{ huntId, code, enabled }' }, 409: { description: invalid_hunt_state } }
 * /api/admin/hunts/{id}/lifecycle:
 *   post:
 *     tags: [Admin Hunts]
 *     security: [{ bearerAuth: [] }]
 *     summary: Admin lifecycle override (publish, start, pause, resume, finish, cancel) with a required reason; audited
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [action, reason], properties: { action: { type: string, enum: [publish, start, pause, resume, finish, cancel] }, reason: { type: string, minLength: 3, maxLength: 500 } } } } }
 *     responses:
 *       200: { description: Updated Hunt }
 *       400: { description: invalid_input (missing reason or unknown action) }
 *       404: { description: not_found }
 *       409: { description: 'invalid_transition: { message, currentStatus, allowedActions }' }
 *       422: { description: 'hunt_not_ready: { issues } (publish only)' }
 */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZES = new Set([10, 25, 50, 100]);
const FILTER_KEYS = ['q', 'status', 'organizationId', 'organizerId', 'city', 'country', 'startFrom', 'startTo', 'createdFrom', 'createdTo', 'sort', 'order'];

class InvalidQuery extends Error {}
function parseFilter(query: Record<string, unknown>, extra: string[] = []): AdminHuntFilter {
  if (Object.keys(query).some(k => ![...FILTER_KEYS, ...extra].includes(k))) throw new InvalidQuery();
  const text = (key: string, max = 120) => {
    const value = query[key];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || value.trim().length > max) throw new InvalidQuery();
    return value.trim() || undefined;
  };
  const day = (key: string) => {
    const value = text(key, 10);
    if (value !== undefined && (!date.test(value) || Number.isNaN(Date.parse(value)))) throw new InvalidQuery();
    return value;
  };
  const id = (key: string) => { const value = text(key, 36); if (value !== undefined && !uuid.test(value)) throw new InvalidQuery(); return value; };
  const status = text('status', 20);
  if (status !== undefined && !HUNT_STATUSES.includes(status as HuntStatus)) throw new InvalidQuery();
  const sort = text('sort', 10) ?? 'created';
  if (!(sort in SORTS)) throw new InvalidQuery();
  const order = text('order', 4) ?? 'desc';
  if (order !== 'asc' && order !== 'desc') throw new InvalidQuery();
  return { q: text('q'), status: status as HuntStatus | undefined, organizationId: id('organizationId'), organizerId: id('organizerId'),
    city: text('city'), country: text('country'), startFrom: day('startFrom'), startTo: day('startTo'),
    createdFrom: day('createdFrom'), createdTo: day('createdTo'), sort: sort as AdminHuntSort, order };
}

function fail(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof InvalidQuery) return res.status(400).json({ error: 'invalid_input' });
  if (error instanceof AdminHuntError) return res.status(error.status).json({ error: error.code, ...error.extra });
  return next(error);
}

export const adminHuntsRouter = express.Router();
adminHuntsRouter.use(requireAuth, requireRole('admin'), (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

adminHuntsRouter.get('/', async (req, res, next) => {
  try {
    const filter = parseFilter(req.query as Record<string, unknown>, ['page', 'pageSize']);
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const pageSize = req.query.pageSize === undefined ? 25 : Number(req.query.pageSize);
    if (!Number.isInteger(page) || page < 1 || page > 100000 || !PAGE_SIZES.has(pageSize)) throw new InvalidQuery();
    return res.json(await AdminHunts.list(filter, page, pageSize));
  } catch (error) { return fail(error, res, next); }
});

adminHuntsRouter.get('/filters', async (_req, res, next) => {
  try { return res.json(await AdminHunts.filterOptions()); } catch (error) { return fail(error, res, next); }
});

adminHuntsRouter.get('/export', async (req, res, next) => {
  try {
    const result = await AdminHunts.exportCsv(parseFilter(req.query as Record<string, unknown>));
    return res.json({ filename: `tedixhunt-hunts-${new Date().toISOString().slice(0, 10)}.csv`, ...result });
  } catch (error) { return fail(error, res, next); }
});

adminHuntsRouter.get('/:id', async (req, res, next) => {
  try {
    if (!uuid.test(String(req.params.id))) return res.status(404).json({ error: 'not_found' });
    const detail = await AdminHunts.detail(String(req.params.id));
    return detail ? res.json(detail) : res.status(404).json({ error: 'not_found' });
  } catch (error) { return fail(error, res, next); }
});

adminHuntsRouter.get('/:id/history', async (req, res, next) => {
  try {
    if (!uuid.test(String(req.params.id))) return res.status(404).json({ error: 'not_found' });
    if (!await Hunt.findById(String(req.params.id))) return res.status(404).json({ error: 'not_found' });
    return res.json({ events: await AdminHunts.history(String(req.params.id)) });
  } catch (error) { return fail(error, res, next); }
});

adminHuntsRouter.post('/:id/access', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    if (!uuid.test(id)) return res.status(404).json({ error: 'not_found' });
    const hunt = await Hunt.findById(id);
    if (!hunt) return res.status(404).json({ error: 'not_found' });
    if (!['published', 'active', 'paused'].includes(hunt.status)) return res.status(409).json({ error: 'invalid_hunt_state' });
    const accessed = await Hunt.ensureAccessCode(id);
    if (!accessed?.accessCode) return res.status(409).json({ error: 'invalid_hunt_state' });
    return res.json({ huntId: accessed.id, code: accessed.accessCode, enabled: accessed.invitationEnabled ?? true });
  } catch (error) { return fail(error, res, next); }
});

adminHuntsRouter.post('/:id/lifecycle', async (req: AuthRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const body = req.body;
    const reason = body && typeof body === 'object' && typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!uuid.test(id)) return res.status(404).json({ error: 'not_found' });
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== 'action,reason'
      || !isLifecycleAction(body.action)) return res.status(400).json({ error: 'invalid_input' });
    if (reason.length < 3 || reason.length > 500) return res.status(400).json({ error: 'reason_required', message: 'Give a reason of 3 to 500 characters.' });
    return res.json(await AdminHunts.override(id, body.action, reason, req.user!));
  } catch (error) { return fail(error, res, next); }
});
