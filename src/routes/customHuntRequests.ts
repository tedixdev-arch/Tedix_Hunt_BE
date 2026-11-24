import express, { type NextFunction, type Response } from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { verifyJwt } from '../lib/jwt.js';
import { TokenBuckets } from '../middleware/abuseProtection.js';
import { flushMail } from '../lib/mail.js';
import { CustomHuntRequests, CustomRequestError } from '../models/CustomHuntRequest.js';

/**
 * @openapi
 * /api/custom-hunt-requests:
 *   post:
 *     tags: [Custom Hunt requests]
 *     summary: Ask the Tedix team for a custom Hunt
 *     description: Public. With a valid access token the request is linked to that account and, when organizationId is given (or the account belongs to exactly one organization), to that organization. Only organization-linked requests can be assigned, because the finished Hunt is exclusive to that organization.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contactName, contactEmail, details]
 *             properties:
 *               contactName: { type: string, maxLength: 120 }
 *               contactEmail: { type: string, format: email, maxLength: 254 }
 *               organizationId: { type: string, format: uuid }
 *               organizationName: { type: string, maxLength: 160 }
 *               city: { type: string, maxLength: 120 }
 *               preferredDate: { type: string, format: date }
 *               participantCount: { type: integer, minimum: 1 }
 *               details: { type: string, maxLength: 4000 }
 *     responses: { 201: { description: Request received }, 400: { description: Invalid input }, 403: { description: Not a member of organizationId } }
 * /api/custom-hunt-requests/mine:
 *   get:
 *     tags: [Custom Hunt requests]
 *     security: [{ bearerAuth: [] }]
 *     summary: Requests the caller submitted or that belong to the caller's organizations
 *     description: Each request has progress in_work | done | rejected | closed, the note from the Tedix team, and (when done) the exclusive Hunt template's name and locality.
 *     responses: { 200: { description: Requests, newest first } }
 * /api/admin/custom-hunt-requests:
 *   get:
 *     tags: [Custom Hunt requests]
 *     security: [{ bearerAuth: [] }]
 *     summary: Custom Hunt request queue with assigned Creator and linked template
 *     responses: { 200: { description: Requests, open first } }
 * /api/admin/custom-hunt-requests/{id}:
 *   patch:
 *     tags: [Custom Hunt requests]
 *     security: [{ bearerAuth: [] }]
 *     summary: Update status (new, in_review, closed), internal note or note shown to the Organizer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { status: { type: string, enum: [new, in_review, closed] }, adminNote: { type: string, maxLength: 2000, nullable: true }, organizerNote: { type: string, maxLength: 2000, nullable: true } } }
 *     responses: { 200: { description: Updated request }, 404: { description: Unknown request }, 409: { description: request_finalized or request_assigned } }
 * /api/admin/custom-hunt-requests/{id}/assign:
 *   post:
 *     tags: [Custom Hunt requests]
 *     security: [{ bearerAuth: [] }]
 *     summary: Assign (or reassign) the request to an active Creator; the first assignment emails the Organizer
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [creatorUserId], properties: { creatorUserId: { type: string, format: uuid } } } } }
 *     responses: { 200: { description: Assigned request }, 404: { description: Unknown request or Creator }, 409: { description: organization_required, request_finalized or template_in_progress } }
 * /api/admin/custom-hunt-requests/{id}/reject:
 *   post:
 *     tags: [Custom Hunt requests]
 *     security: [{ bearerAuth: [] }]
 *     summary: Reject the request with a note for the Organizer, who is emailed
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [organizerNote], properties: { organizerNote: { type: string, minLength: 1, maxLength: 2000 } } } } }
 *     responses: { 200: { description: Rejected request }, 409: { description: request_finalized } }
 * /api/creator/custom-requests:
 *   get:
 *     tags: [Custom Hunt requests]
 *     security: [{ bearerAuth: [] }]
 *     summary: Custom Hunt briefs assigned to the calling Creator (no Organizer contact details)
 *     responses: { 200: { description: Assigned requests } }
 * /api/creator/custom-requests/{id}/template:
 *   put:
 *     tags: [Custom Hunt requests]
 *     security: [{ bearerAuth: [] }]
 *     summary: Link one of the Creator's own unapproved Local templates to the assigned request
 *     description: Approving that template (Admin template review) completes the request, makes the template exclusive to the requesting organization and emails the Organizer.
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [key], properties: { key: { type: string } } } } }
 *     responses: { 200: { description: Linked request }, 404: { description: Unknown request or template }, 409: { description: template_not_local, template_already_linked, template_already_approved, request_already_linked or request_not_assignable } }
 */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const note = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 2000);
const clean = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const noStore = ((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); }) as express.RequestHandler;

function fail(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof CustomRequestError) return res.status(error.status).json({ error: error.code });
  return next(error);
}

/* Public submission + Organizer tracking. */
const requestBuckets = new TokenBuckets(10000);
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const optionalText = (value: unknown, max: number) => value === undefined || value === null || (typeof value === 'string' && value.trim().length <= max);
export const customHuntRequestsRouter = express.Router();
customHuntRequestsRouter.post('/', async (req: AuthRequest, res, next) => {
  const retry = requestBuckets.consume(req.ip ?? 'unknown', { capacity: 10, windowMs: 60 * 60 * 1000 });
  if (retry) { res.set('Retry-After', String(retry)); return res.status(429).json({ error: 'rate_limited' }); }
  const b = req.body;
  const allowed = ['contactName', 'contactEmail', 'organizationId', 'organizationName', 'city', 'preferredDate', 'participantCount', 'details'];
  if (!record(b) || Object.keys(b).some(k => !allowed.includes(k))
    || typeof b.contactName !== 'string' || !b.contactName.trim() || b.contactName.trim().length > 120
    || typeof b.contactEmail !== 'string' || !email.test(b.contactEmail.trim()) || b.contactEmail.trim().length > 254
    || typeof b.details !== 'string' || !b.details.trim() || b.details.trim().length > 4000
    || (b.organizationId !== undefined && b.organizationId !== null && (typeof b.organizationId !== 'string' || !uuid.test(b.organizationId)))
    || !optionalText(b.organizationName, 160) || !optionalText(b.city, 120)
    || (b.preferredDate !== undefined && b.preferredDate !== null && (typeof b.preferredDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.preferredDate) || Number.isNaN(Date.parse(b.preferredDate))))
    || (b.participantCount !== undefined && b.participantCount !== null && (!Number.isInteger(b.participantCount) || (b.participantCount as number) < 1 || (b.participantCount as number) > 100000))) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  let userId: string | null = null;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyJwt<{ sub?: unknown; type?: unknown }>(header.slice(7));
      if (payload.type === 'access' && typeof payload.sub === 'string') userId = payload.sub;
    } catch { /* Anonymous requests are allowed. */ }
  }
  try {
    return res.status(201).json(await CustomHuntRequests.submit({
      userId, organizationId: typeof b.organizationId === 'string' ? b.organizationId.toLowerCase() : null,
      contactName: (b.contactName as string).trim(), contactEmail: (b.contactEmail as string).trim().toLowerCase(),
      organizationName: clean(b.organizationName), city: clean(b.city), preferredDate: (b.preferredDate as string | undefined) ?? null,
      participantCount: (b.participantCount as number | undefined) ?? null, details: (b.details as string).trim(),
    }));
  } catch (error) { return fail(error, res, next); }
});
customHuntRequestsRouter.get('/mine', noStore, requireAuth, async (req: AuthRequest, res, next) => {
  try { return res.json({ requests: await CustomHuntRequests.listForOrganizer(req.user!.id) }); }
  catch (error) { return fail(error, res, next); }
});

/* Admin queue. */
export const adminCustomHuntRequestsRouter = express.Router();
adminCustomHuntRequestsRouter.use(noStore, requireAuth, requireRole('admin'));
adminCustomHuntRequestsRouter.get('/', async (_req, res, next) => {
  try { return res.json({ requests: await CustomHuntRequests.listAdmin() }); } catch (error) { return fail(error, res, next); }
});
adminCustomHuntRequestsRouter.patch('/:id', async (req, res, next) => {
  const body = req.body;
  if (!uuid.test(String(req.params.id)) || !record(body) || !Object.keys(body).length
    || Object.keys(body).some(k => !['status', 'adminNote', 'organizerNote'].includes(k))
    || (body.status !== undefined && !['new', 'in_review', 'closed'].includes(body.status as string))
    || (body.adminNote !== undefined && !note(body.adminNote)) || (body.organizerNote !== undefined && !note(body.organizerNote))) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    return res.json(await CustomHuntRequests.update(String(req.params.id), {
      status: body.status as 'new' | 'in_review' | 'closed' | undefined,
      ...(body.adminNote !== undefined ? { adminNote: clean(body.adminNote) } : {}),
      ...(body.organizerNote !== undefined ? { organizerNote: clean(body.organizerNote) } : {}),
    }));
  } catch (error) { return fail(error, res, next); }
});
adminCustomHuntRequestsRouter.post('/:id/assign', async (req, res, next) => {
  const body = req.body;
  if (!uuid.test(String(req.params.id)) || !record(body) || Object.keys(body).join() !== 'creatorUserId'
    || typeof body.creatorUserId !== 'string' || !uuid.test(body.creatorUserId)) return res.status(400).json({ error: 'invalid_input' });
  try {
    const result = await CustomHuntRequests.assign(String(req.params.id), body.creatorUserId.toLowerCase());
    void flushMail();
    return res.json(result);
  } catch (error) { return fail(error, res, next); }
});
adminCustomHuntRequestsRouter.post('/:id/reject', async (req, res, next) => {
  const body = req.body;
  const text = record(body) ? clean(body.organizerNote) : null;
  if (!uuid.test(String(req.params.id)) || !record(body) || Object.keys(body).join() !== 'organizerNote' || !text || text.length > 2000)
    return res.status(400).json({ error: 'invalid_input' });
  try {
    const result = await CustomHuntRequests.reject(String(req.params.id), text);
    void flushMail();
    return res.json(result);
  } catch (error) { return fail(error, res, next); }
});

/* Creator briefs. */
export const creatorCustomHuntRequestsRouter = express.Router();
creatorCustomHuntRequestsRouter.use(noStore, requireAuth, requireRole('creator'));
creatorCustomHuntRequestsRouter.get('/', async (req: AuthRequest, res, next) => {
  try { return res.json({ requests: await CustomHuntRequests.listForCreator(req.user!.id) }); } catch (error) { return fail(error, res, next); }
});
creatorCustomHuntRequestsRouter.put('/:id/template', async (req: AuthRequest, res, next) => {
  const body = req.body;
  if (!uuid.test(String(req.params.id)) || !record(body) || Object.keys(body).join() !== 'key'
    || typeof body.key !== 'string' || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(body.key)) return res.status(400).json({ error: 'invalid_input' });
  try {
    await CustomHuntRequests.linkTemplate(String(req.params.id), req.user!.id, body.key);
    const linked = (await CustomHuntRequests.listForCreator(req.user!.id)).find(r => r.id === String(req.params.id).toLowerCase());
    return res.json(linked);
  } catch (error) { return fail(error, res, next); }
});
