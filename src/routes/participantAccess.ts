import { TokenBuckets } from '../middleware/abuseProtection.js';
import express, { type RequestHandler } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { normalizeHuntAccessCode } from '../domain/huntAccess.js';
import { ParticipantAccessError, record, validObservation } from '../domain/participantAccess.js';
import { ParticipantAccess } from '../models/ParticipantAccess.js';
import { Gameplay } from '../models/Gameplay.js';
import { validAnswerBody } from '../domain/gameplay.js';
import { setting } from '../domain/platformSettings.js';

const admissionBuckets = new TokenBuckets(10000);
const gameplayBuckets = new TokenBuckets(10000);
const limited = (key: string, capacity: number, res: express.Response) => {
  const retry = gameplayBuckets.consume(key, { capacity, windowMs: 60000 });
  if (retry) { res.set('Retry-After', String(retry)); res.status(429).json({ error: 'rate_limited' }); }
  return !!retry;
};
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
 *         gameplayCompleted: { type: boolean }
 *         mayAccessGameplay: { type: boolean }
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
 *         enrollmentPolicy: { type: string, enum: [organizer_invitation] }
 *         proximityPolicy: { type: string, enum: [pilot-solo-2026-11] }
 *         checkpoints:
 *           type: array
 *           items: { $ref: '#/components/schemas/ParticipantCheckpointAccessStatus' }
 * /api/hunts/{id}/participants/enroll:
 *   post:
 *     tags: [Participant access]
 *     security: [{ bearerAuth: [] }]
 *     summary: Enroll with an Organizer invitation or rejoin existing membership
 *     description: D7-A bearer invitation admission for authenticated accounts and guests in published/active Hunts with capacity. Existing members rejoin published/active/paused Hunts without a code. Does not create Teams.
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
 *       429: { description: Admission rate limit exceeded }
 * /api/hunts/{id}/participants/me:
 *   get:
 *     tags: [Participant access]
 *     security: [{ bearerAuth: [] }]
 *     summary: Retrieve durable caller-scoped Hunt access context
 *     description: Returns participantId, joinedAt, huntStatus, templateVersion, policy status and checkpoint statuses. No snapshot or challenge definitions. The first incomplete checkpoint is eligible for proximity; later checkpoints unlock as earlier ones are completed.
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
 *     description: Server-generated snapshot-scoped checkpointId. Returns accessState (not_yet_accessible, eligible_for_proximity or proximity_verified), verifiedAt, kind, gameplayCompleted and mayAccessGameplay. Reading status does not grant access.
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
 *     summary: Verify arrival at the current checkpoint
 *     description: Strict numeric coordinates, nonnegative accuracyMeters and canonical UTC millisecond observedAt. Checks membership, lifecycle and checkpoint eligibility. Pilot policy, see docs/Participant_Gameplay_Pilot.md. The observation must be at most GAMEPLAY_PROXIMITY_MAX_AGE_MS old (default 30 s), accuracy at most GAMEPLAY_PROXIMITY_MAX_ACCURACY_METERS (default 20 m), inside the pinned effective radius. Failures are 422 proximity_stale, proximity_inaccurate, proximity_outside_radius or checkpoint_geography_unavailable. Client GPS is spoofable and is not proof of presence; Organizers can confirm arrival instead.
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
 *       200: { description: Arrival verified; checkpoint gameplay unlocked }
 *       422: { description: Geography unavailable or observation rejected; no state changes }
 */
router.post('/participants/enroll', handle(async (req: AuthRequest, res) => {
  const retry = admissionBuckets.consume(req.user!.id, { capacity: 60, windowMs: 60000 });
  if (retry) { res.set('Retry-After', String(retry)); res.status(429).json({ error: 'rate_limited' }); return; }
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
  if (limited(`proximity:${req.user!.id}`, 60, res)) return;
  res.json(await ParticipantAccess.verify(String(req.params.id), req.user!.id, String(req.params.checkpointId), req.body));
}));

/**
 * @openapi
 * /api/hunts/{id}/participants/me/play:
 *   get:
 *     tags: [Participant gameplay]
 *     security: [{ bearerAuth: [] }]
 *     summary: Current pilot Solo gameplay state
 *     description: Returns mission, score, checkpoint progress and the current stage (navigate, personal, team, waiting or finished). Challenge content is delivered only after arrival is verified and never includes answers, hints or solutions.
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Caller-scoped gameplay state }
 *       401: { description: Authentication required }
 *       404: { description: No Hunt membership }
 *       409: { description: Ineligible lifecycle or snapshot conflict }
 * /api/hunts/{id}/checkpoints/{checkpointId}/answer:
 *   post:
 *     tags: [Participant gameplay]
 *     security: [{ bearerAuth: [] }]
 *     summary: Submit a personal or team-stage answer for the current checkpoint
 *     description: The server checks the answer against the pinned Hunt snapshot. Wrong answers return correct=false without revealing expected values.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: checkpointId, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - { type: object, required: [stage, answers], properties: { stage: { type: string, enum: [personal] }, answers: { type: object, additionalProperties: { type: string, maxLength: 200 } } } }
 *               - { type: object, required: [stage, answer], properties: { stage: { type: string, enum: [team] }, answer: { type: string, maxLength: 200 } } }
 *     responses:
 *       200: { description: Result and refreshed gameplay state }
 *       400: { description: Invalid body }
 *       409: { description: Hunt not active, checkpoint not current or verified, or stage already solved }
 *       422: { description: Challenge content is not supported by pilot gameplay }
 *       429: { description: Too many attempts }
 * /api/hunts/{id}/participants/me/help:
 *   post:
 *     tags: [Participant gameplay]
 *     security: [{ bearerAuth: [] }]
 *     summary: Ask the Organizer for help or report an emergency
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [kind], properties: { kind: { type: string, enum: [help, emergency] }, message: { type: string, maxLength: 500 } } }
 *     responses:
 *       201: { description: Help request recorded }
 * /api/hunts/{id}/leaderboard:
 *   get:
 *     tags: [Participant gameplay]
 *     security: [{ bearerAuth: [] }]
 *     summary: Hunt leaderboard for members, Organizers and supervisors
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Ranked entries with display names only }
 *       404: { description: Not a member or staff of this Hunt }
 */
router.get('/participants/me/play', handle(async (req: AuthRequest, res) => {
  res.json(await Gameplay.state(String(req.params.id), req.user!.id));
}));
router.post('/checkpoints/:checkpointId/answer', handle(async (req: AuthRequest, res) => {
  if (!uuid.test(String(req.params.checkpointId))) { res.status(404).json({ error: 'not_found' }); return; }
  if (!validAnswerBody(req.body)) { res.status(400).json({ error: 'invalid_input' }); return; }
  if (limited(`answer:${req.user!.id}`, setting<number>('gameplay.answerAttemptsPerMinute'), res)) return;
  res.json(await Gameplay.answer(String(req.params.id), req.user!.id, String(req.params.checkpointId), req.body));
}));
router.post('/participants/me/help', handle(async (req: AuthRequest, res) => {
  const body = req.body;
  if (!record(body) || !['help', 'emergency'].includes(body.kind) || Object.keys(body).some(k => k !== 'kind' && k !== 'message')
    || (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 500))) {
    res.status(400).json({ error: 'invalid_input' }); return;
  }
  if (limited(`help:${req.user!.id}`, 10, res)) return;
  res.status(201).json(await Gameplay.requestHelp(String(req.params.id), req.user!.id, body.kind, (body.message ?? '').trim()));
}));
router.get('/leaderboard', handle(async (req: AuthRequest, res) => {
  res.json(await Gameplay.leaderboard(String(req.params.id), req.user!.id));
}));
export const participantAccessRouter = router;
