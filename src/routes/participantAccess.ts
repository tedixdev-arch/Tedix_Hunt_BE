import express, { type RequestHandler } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { normalizeHuntAccessCode } from '../domain/huntAccess.js';
import { ParticipantAccessError, record, validObservation } from '../domain/participantAccess.js';
import { ParticipantAccess } from '../models/ParticipantAccess.js';

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.use((req, res, next) => uuid.test(String(req.params.id)) ? next() : res.status(404).json({ error: 'not_found' }));
const handle = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
  try { await handler(req, res, next); }
  catch (error) {
    if (error instanceof ParticipantAccessError) { res.status(error.status).json({ error: error.code }); return; }
    next(error);
  }
};

/**
 * @openapi
 * components:
 *   schemas:
 *     ParticipantCheckpointAccessStatus:
 *       type: object
 *       additionalProperties: false
 *       required: [checkpointId, kind, accessState, gameplayCompleted, mayAccessGameplay, verifiedAt]
 *       properties:
 *         checkpointId: { type: string, format: uuid }
 *         kind: { type: string, enum: [regular, finish] }
 *         accessState: { type: string, enum: [not_yet_accessible, eligible_for_proximity, proximity_verified] }
 *         gameplayCompleted: { type: boolean, enum: [false] }
 *         mayAccessGameplay: { type: boolean, enum: [false] }
 *         verifiedAt: { type: string, format: date-time, nullable: true }
 *     ParticipantHuntAccessContext:
 *       type: object
 *       additionalProperties: false
 *       required: [huntId, participantId, joinedAt, huntStatus, templateVersion, enrollmentPolicy, proximityPolicy, checkpoints]
 *       properties:
 *         huntId: { type: string, format: uuid }
 *         participantId: { type: string, format: uuid }
 *         joinedAt: { type: string, format: date-time }
 *         huntStatus: { type: string, enum: [published, active, paused] }
 *         templateVersion: { type: integer, minimum: 1 }
 *         enrollmentPolicy: { type: string, enum: [existing_members_only] }
 *         proximityPolicy: { type: string, enum: [unresolved] }
 *         checkpoints:
 *           type: array
 *           items: { $ref: '#/components/schemas/ParticipantCheckpointAccessStatus' }
 * /api/hunts/{id}/participants/enroll:
 *   post:
 *     tags: [Participant access]
 *     security: [{ bearerAuth: [] }]
 *     summary: Rejoin an existing authenticated Hunt membership
 *     description: Idempotent existing-member rejoin only. New membership is denied with enrollment_policy_unresolved (D7), even with a valid code. Does not create Teams. Published, active and paused Hunts only.
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               accessCode: { type: string, pattern: '^[A-HJ-NP-Z2-9]{8}$' }
 *     responses:
 *       200: { description: Caller-scoped stable membership and checkpoint IDs, content: { application/json: { schema: { $ref: '#/components/schemas/ParticipantHuntAccessContext' } } } }
 *       400: { description: Invalid or unknown body fields }
 *       401: { description: Authentication required }
 *       404: { description: Invalid code or inaccessible Hunt }
 *       409: { description: Ineligible Hunt or unavailable/conflicting snapshot }
 *       422: { description: New enrollment policy unresolved }
 * /api/hunts/{id}/participants/me:
 *   get:
 *     tags: [Participant access]
 *     security: [{ bearerAuth: [] }]
 *     summary: Retrieve durable caller-scoped Hunt access context
 *     description: Returns participantId, joinedAt, huntStatus, templateVersion, policy status and checkpoint statuses. No snapshot or challenge definitions. First checkpoint is eligible for proximity; later checkpoints stay locked. No gameplay completion or GPS grants are enabled.
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Caller-scoped Hunt context, content: { application/json: { schema: { $ref: '#/components/schemas/ParticipantHuntAccessContext' } } } }
 *       401: { description: Authentication required }
 *       404: { description: No Hunt membership }
 *       409: { description: Ineligible lifecycle or snapshot conflict }
 * /api/hunts/{id}/checkpoints/{checkpointId}/access:
 *   get:
 *     tags: [Participant access]
 *     security: [{ bearerAuth: [] }]
 *     summary: Retrieve checkpoint access status including playable FinishPoint
 *     description: Server-generated snapshot-scoped checkpointId. Returns accessState (not_yet_accessible, eligible_for_proximity or proximity_verified), verifiedAt, kind, gameplayCompleted=false and mayAccessGameplay=false. Reading status does not grant access.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: checkpointId, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Checkpoint access status, content: { application/json: { schema: { $ref: '#/components/schemas/ParticipantCheckpointAccessStatus' } } } }
 *       401: { description: Authentication required }
 *       404: { description: Inaccessible Hunt or checkpoint }
 *       409: { description: Ineligible lifecycle or snapshot conflict }
 * /api/hunts/{id}/checkpoints/{checkpointId}/proximity:
 *   post:
 *     tags: [Participant access]
 *     security: [{ bearerAuth: [] }]
 *     summary: Validate a proximity request (grants disabled pending policy approval)
 *     description: Strict numeric coordinates, nonnegative accuracyMeters and canonical UTC millisecond observedAt. Checks membership, lifecycle and checkpoint eligibility. Missing snapshot GPS is 422 checkpoint_geography_unavailable; otherwise 422 proximity_policy_unresolved. No successful GPS grant exists yet. Client GPS is spoofable and is not proof of presence.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: checkpointId, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [latitude, longitude, accuracyMeters, observedAt]
 *             properties:
 *               latitude: { type: number, minimum: -90, maximum: 90 }
 *               longitude: { type: number, minimum: -180, maximum: 180 }
 *               accuracyMeters: { type: number, minimum: 0 }
 *               observedAt: { type: string, format: date-time, example: '2026-10-31T20:00:00.000Z' }
 *     responses:
 *       400: { description: Invalid observation or unknown fields }
 *       401: { description: Authentication required }
 *       404: { description: Inaccessible Hunt or checkpoint }
 *       409: { description: Hunt inactive, future checkpoint, or snapshot conflict }
 *       422: { description: Geography unavailable or proximity policy unresolved; no state changes }
 */
router.post('/participants/enroll', handle(async (req: AuthRequest, res) => {
  if (!record(req.body) || Object.keys(req.body).some(k => k !== 'accessCode') ||
    (req.body.accessCode !== undefined && typeof req.body.accessCode !== 'string')) {
    res.status(400).json({ error: 'invalid_input' }); return;
  }
  const code = req.body.accessCode === undefined ? undefined : normalizeHuntAccessCode(req.body.accessCode);
  if (code === null) { res.status(404).json({ error: 'not_found' }); return; }
  res.json(await ParticipantAccess.context(String(req.params.id), req.user!.id, code));
}));
router.get('/participants/me', handle(async (req: AuthRequest, res) => {
  res.json(await ParticipantAccess.context(String(req.params.id), req.user!.id));
}));
router.get('/checkpoints/:checkpointId/access', handle(async (req: AuthRequest, res) => {
  if (!uuid.test(String(req.params.checkpointId))) { res.status(404).json({ error: 'not_found' }); return; }
  res.json(await ParticipantAccess.checkpoint(String(req.params.id), req.user!.id, String(req.params.checkpointId)));
}));
router.post('/checkpoints/:checkpointId/proximity', handle(async (req: AuthRequest, res) => {
  if (!uuid.test(String(req.params.checkpointId))) { res.status(404).json({ error: 'not_found' }); return; }
  if (!validObservation(req.body)) { res.status(400).json({ error: 'invalid_input' }); return; }
  res.json(await ParticipantAccess.verify(String(req.params.id), req.user!.id, String(req.params.checkpointId)));
}));
export const participantAccessRouter = router;
