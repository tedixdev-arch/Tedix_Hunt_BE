import express from 'express';
import { requireAnyRole, requireAuth, type AuthRequest } from '../middleware/auth.js';
import { Hunt, type HuntStatus, type UpdateHuntGeneralSetupInput } from '../models/Hunt.js';
import { HuntRoles } from '../models/HuntRole.js';
import { Organization } from '../models/Organization.js';
import { findHuntTemplate } from '../domain/huntTemplates.js';
import { supportedHuntOptionValues } from '../domain/huntOptions.js';
import { validateHuntForPublish } from '../domain/huntReadiness.js';

const router = express.Router();

const lifecycleActions: Record<string, { from: readonly HuntStatus[]; to: HuntStatus }> = {
  publish: { from: ['draft'], to: 'published' },
  start: { from: ['published'], to: 'active' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  cancel: { from: ['draft', 'published', 'active', 'paused'], to: 'cancelled' },
  finish: { from: ['active', 'paused'], to: 'finished' },
};

const updateFields = new Set([
  'name', 'country', 'region', 'city', 'startDate', 'startTime', 'timezone',
  'durationMinutes', 'capacity', 'contactName',
  'templateKey',
  'format', 'teamSize', 'accessMode', 'difficulty', 'checkpointOrder',
]);

const validDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
};

const validTimezone = (value: string): boolean => {
  if (/^[+-]\d{2}:\d{2}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
};

const parseDraftUpdate = (body: unknown): UpdateHuntGeneralSetupInput | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (keys.length === 0 || keys.some((key) => !updateFields.has(key))) return null;

  const update: UpdateHuntGeneralSetupInput = {};
  for (const key of keys) {
    const value = values[key];
    if (['name', 'country', 'region', 'city', 'contactName'].includes(key)) {
      if (typeof value !== 'string' || !value.trim()) return null;
      (update as Record<string, unknown>)[key] = value.trim();
    } else if (key === 'startDate') {
      if (typeof value !== 'string' || !validDate(value)) return null;
      update.startDate = value;
    } else if (key === 'startTime') {
      if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return null;
      update.startTime = value.length === 5 ? `${value}:00` : value;
    } else if (key === 'timezone') {
      if (typeof value !== 'string' || !value.trim() || !validTimezone(value.trim())) return null;
      update.timezone = value.trim();
    } else if (key === 'durationMinutes' || key === 'capacity') {
      if (!Number.isInteger(value) || (value as number) < 1) return null;
      update[key] = value as number;
    } else if (key === 'templateKey') {
      if (typeof value !== 'string' || !value.trim()) return null;
      const template = findHuntTemplate(value.trim());
      if (!template) return null;
      update.templateKey = template.key;
      update.templateVersion = template.version;
      update.templateSnapshot = template;
    } else if (key in supportedHuntOptionValues) {
      // Prototype choices are rejected until the pilot runtime actually supports them.
      if (value !== supportedHuntOptionValues[key as keyof typeof supportedHuntOptionValues]) return null;
      (update as Record<string, unknown>)[key] = value;
    }
  }
  return update;
};

/**
 * @openapi
 * tags:
 *   - name: Hunts
 *     description: Hunt drafts and lifecycle
 * components:
 *   schemas:
 *     HuntReadinessIssue:
 *       type: object
 *       required: [section, field, message]
 *       properties:
 *         section: { type: string, enum: [general, template, options] }
 *         field: { type: string }
 *         message: { type: string }
 *     HuntNotReadyError:
 *       type: object
 *       required: [error, issues]
 *       properties:
 *         error: { type: string, enum: [hunt_not_ready] }
 *         issues: { type: array, items: { $ref: '#/components/schemas/HuntReadinessIssue' } }
 *   responses:
 *     HuntUnauthorized: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *     HuntForbidden: { description: Hunt access denied, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *     HuntNotFound: { description: Hunt or organization not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *     InvalidHuntState: { description: Invalid Hunt state transition, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */

/**
 * @openapi
 * /api/hunts:
 *   get:
 *     tags: [Hunts]
 *     summary: List manageable Hunts
 *     description: Returns only Hunts where the authenticated user is a Hunt-specific organizer or supervisor.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Accessible Hunts, ordered by most recently updated and then created
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/HuntListItem' }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *   post:
 *     tags: [Hunts]
 *     summary: Create a Hunt draft
 *     description: Requires creator or organizer capability and organization membership.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [organizationId, name]
 *             properties:
 *               organizationId: { type: string, format: uuid }
 *               name: { type: string }
 *     responses:
 *       201: { description: Hunt draft created, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       400: { description: Invalid input, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 */
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  return res.json(await Hunt.findForUser(req.user!.id));
});

router.post('/', requireAuth, requireAnyRole(['creator', 'organizer']), async (req: AuthRequest, res) => {
  const organizationId = typeof req.body.organizationId === 'string' ? req.body.organizationId : '';
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!organizationId || !name) return res.status(400).json({ error: 'invalid_input' });

  const organization = await Organization.findById(organizationId);
  if (!organization) return res.status(404).json({ error: 'not_found' });
  const userId = req.user!.id;
  const [isOwner, isMember] = await Promise.all([
    Organization.isOwner(userId, organizationId),
    Organization.isMember(userId, organizationId),
  ]);
  if (!isOwner && !isMember) return res.status(403).json({ error: 'forbidden' });

  const hunt = await Hunt.createWithOrganizerRole({ organizationId, createdByUserId: userId, name });
  return res.status(201).json(hunt);
});

/**
 * @openapi
 * /api/hunts/{id}:
 *   get:
 *     tags: [Hunts]
 *     summary: Read a Hunt
 *     description: Hunt organizers and supervisors may read the Hunt.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Hunt, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 *   patch:
 *     tags: [Hunts]
 *     summary: Partially update a draft Hunt
 *     description: Only a Hunt-specific organizer may update General Setup, select an approved template, or save supported pilot options, and only while the Hunt is a draft. Unsupported prototype options are rejected. Template version and snapshot are generated by the backend.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               name: { type: string }
 *               country: { type: string }
 *               region: { type: string }
 *               city: { type: string }
 *               startDate: { type: string, format: date }
 *               startTime: { type: string, description: Local time in HH:MM or HH:MM:SS format }
 *               timezone: { type: string, example: Europe/Bucharest, description: IANA timezone }
 *               durationMinutes: { type: integer, minimum: 1 }
 *               capacity: { type: integer, minimum: 1 }
 *               contactName: { type: string }
 *               templateKey: { type: string, example: signal-cluj-napoca }
 *               format: { type: string, enum: [team], description: Currently supported pilot value }
 *               teamSize: { type: integer, enum: [4], description: Currently supported pilot value; configuration only }
 *               accessMode: { type: string, enum: [invitation_only], description: Currently supported pilot value; does not generate invitations }
 *               difficulty: { type: string, enum: [easy], description: Currently supported pilot value }
 *               checkpointOrder: { type: string, enum: [recommended], description: Currently supported pilot value }
 *             additionalProperties: false
 *     responses:
 *       200: { description: Updated Hunt, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       400: { description: Invalid input, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 *       409: { $ref: '#/components/responses/InvalidHuntState' }
 */
router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
  const id = String(req.params.id);
  const hunt = await Hunt.findById(id);
  if (!hunt) return res.status(404).json({ error: 'not_found' });
  const userId = req.user!.id;
  const [organizer, supervisor] = await Promise.all([
    HuntRoles.hasRole(id, userId, 'organizer'),
    HuntRoles.hasRole(id, userId, 'supervisor'),
  ]);
  if (!organizer && !supervisor) return res.status(403).json({ error: 'forbidden' });
  return res.json(hunt);
});

router.patch('/:id', requireAuth, async (req: AuthRequest, res) => {
  const id = String(req.params.id);
  const hunt = await Hunt.findById(id);
  if (!hunt) return res.status(404).json({ error: 'not_found' });
  if (!(await HuntRoles.hasRole(id, req.user!.id, 'organizer'))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const update = parseDraftUpdate(req.body);
  if (!update) return res.status(400).json({ error: 'invalid_input' });
  if (hunt.status !== 'draft') return res.status(409).json({ error: 'invalid_hunt_state' });
  const updated = await Hunt.updateDraft(id, update);
  if (!updated) return res.status(409).json({ error: 'invalid_hunt_state' });
  return res.json(updated);
});

/**
 * @openapi
 * /api/hunts/{id}/publish:
 *   post:
 *     tags: [Hunts]
 *     summary: Publish a draft Hunt (draft to published)
 *     description: Requires the Hunt-specific organizer role, draft state, and complete persisted General Setup, template snapshot, and supported pilot options.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Updated Hunt, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 *       409: { $ref: '#/components/responses/InvalidHuntState' }
 *       422:
 *         description: Hunt exists and is a draft but its required persisted setup is incomplete
 *         content: { application/json: { schema: { $ref: '#/components/schemas/HuntNotReadyError' } } }
 */
/**
 * @openapi
 * /api/hunts/{id}/start:
 *   post:
 *     tags: [Hunts]
 *     summary: Start a published Hunt (published to active)
 *     description: Requires the Hunt-specific organizer role and the required current state.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Updated Hunt, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 *       409: { $ref: '#/components/responses/InvalidHuntState' }
 */
/**
 * @openapi
 * /api/hunts/{id}/pause:
 *   post:
 *     tags: [Hunts]
 *     summary: Pause an active Hunt (active to paused)
 *     description: Requires the Hunt-specific organizer role and the required current state.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Updated Hunt, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 *       409: { $ref: '#/components/responses/InvalidHuntState' }
 */
/**
 * @openapi
 * /api/hunts/{id}/resume:
 *   post:
 *     tags: [Hunts]
 *     summary: Resume a paused Hunt (paused to active)
 *     description: Requires the Hunt-specific organizer role and the required current state.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Updated Hunt, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 *       409: { $ref: '#/components/responses/InvalidHuntState' }
 */
/**
 * @openapi
 * /api/hunts/{id}/cancel:
 *   post:
 *     tags: [Hunts]
 *     summary: Cancel a draft, published, active, or paused Hunt
 *     description: Requires the Hunt-specific organizer role and the required current state.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Updated Hunt, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 *       409: { $ref: '#/components/responses/InvalidHuntState' }
 */
/**
 * @openapi
 * /api/hunts/{id}/finish:
 *   post:
 *     tags: [Hunts]
 *     summary: Finish an active or paused Hunt
 *     description: Requires the Hunt-specific organizer role and the required current state.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Updated Hunt, content: { application/json: { schema: { $ref: '#/components/schemas/Hunt' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 *       409: { $ref: '#/components/responses/InvalidHuntState' }
 */
router.post('/:id/:action', requireAuth, async (req: AuthRequest, res) => {
  const id = String(req.params.id);
  const action = lifecycleActions[String(req.params.action)];
  if (!action) return res.status(404).json({ error: 'not_found' });
  const hunt = await Hunt.findById(id);
  if (!hunt) return res.status(404).json({ error: 'not_found' });
  if (!(await HuntRoles.hasRole(id, req.user!.id, 'organizer'))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (String(req.params.action) === 'publish' && hunt.status !== 'draft') {
    return res.status(409).json({ error: 'invalid_hunt_state' });
  }
  if (String(req.params.action) === 'publish') {
    // Publishing is authoritative on persisted setup; frontend readiness is UX only.
    const readiness = validateHuntForPublish(hunt);
    if (!readiness.ready) return res.status(422).json({ error: 'hunt_not_ready', issues: readiness.issues });
  }
  const updated = await Hunt.transitionStatus({ id, ...action });
  if (!updated) return res.status(409).json({ error: 'invalid_hunt_state' });
  return res.json(updated);
});

export const huntsRouter = router;
