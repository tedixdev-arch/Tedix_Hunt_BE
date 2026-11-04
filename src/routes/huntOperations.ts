import express, { type RequestHandler } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { ParticipantAccessError } from '../domain/participantAccess.js';
import { HuntRoles } from '../models/HuntRole.js';
import { Gameplay } from '../models/Gameplay.js';

const router = express.Router({ mergeParams: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handle = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try { await handler(req, res, next); }
  catch (error) {
    if (error instanceof ParticipantAccessError) { res.status(error.status).json({ error: error.code }); return; }
    next(error);
  }
};
// Guards are per route: this router shares the /api/hunts/:id prefix with other Hunt routers.
const staff = (roles: Array<'organizer' | 'supervisor'>, allowAdmin = false): RequestHandler[] => [requireAuth, async (req: AuthRequest, res, next) => {
  res.set('Cache-Control', 'no-store');
  const huntId = String(req.params.id);
  if (!uuid.test(huntId)) { res.status(404).json({ error: 'not_found' }); return; }
  // Platform Admins oversee safety across every Hunt.
  if (allowAdmin && !req.user!.isGuest && req.user!.roles.includes('admin')) { next(); return; }
  const allowed = await Promise.all(roles.map(role => HuntRoles.hasRole(huntId, req.user!.id, role)));
  if (!allowed.some(Boolean)) { res.status(403).json({ error: 'forbidden' }); return; }
  next();
}];

/**
 * @openapi
 * /api/hunts/{id}/monitor:
 *   get:
 *     tags: [Hunt operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Live Organizer view of participants, progress, scores, help requests and recent activity
 *     description: Organizer or supervisor of this Hunt, or a platform Admin. Contains display names and progress only, never answers.
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Monitor snapshot }
 *       403: { description: Not staff of this Hunt }
 * /api/hunts/{id}/participants/{participantId}/checkpoints/{checkpointId}/check-in:
 *   post:
 *     tags: [Hunt operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Organizer confirms a participant's arrival (GPS fallback)
 *     description: Pilot D6 fallback. Only the participant's current eligible checkpoint in an active Hunt; the granting Organizer is recorded.
 *     responses:
 *       200: { description: Arrival confirmed }
 *       409: { description: Hunt inactive or checkpoint not eligible }
 * /api/hunts/{id}/help-requests/{requestId}/resolve:
 *   post:
 *     tags: [Hunt operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Mark a participant help request as resolved
 *     responses:
 *       200: { description: Resolved }
 *       404: { description: Unknown or already resolved request }
 */
router.get('/monitor', ...staff(['organizer', 'supervisor'], true), handle(async (req, res) => {
  res.json(await Gameplay.monitor(String(req.params.id)));
}));
router.post('/participants/:participantId/checkpoints/:checkpointId/check-in', ...staff(['organizer']), handle(async (req: AuthRequest, res) => {
  const { participantId, checkpointId } = req.params as Record<string, string>;
  if (!uuid.test(participantId) || !uuid.test(checkpointId)) { res.status(404).json({ error: 'not_found' }); return; }
  res.json(await Gameplay.checkIn(String(req.params.id), participantId, checkpointId, req.user!.id));
}));
router.post('/help-requests/:requestId/resolve', ...staff(['organizer', 'supervisor'], true), handle(async (req: AuthRequest, res) => {
  if (!uuid.test(String(req.params.requestId))) { res.status(404).json({ error: 'not_found' }); return; }
  res.json(await Gameplay.resolveHelp(String(req.params.id), String(req.params.requestId), req.user!.id));
}));

export const huntOperationsRouter = router;
