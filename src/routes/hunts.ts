import express from 'express';
import { requireAnyRole, requireAuth, type AuthRequest } from '../middleware/auth.js';
import { Hunt, type HuntStatus } from '../models/Hunt.js';
import { HuntRoles } from '../models/HuntRole.js';
import { Organization } from '../models/Organization.js';

const router = express.Router();

const lifecycleActions: Record<string, { from: readonly HuntStatus[]; to: HuntStatus }> = {
  publish: { from: ['draft'], to: 'published' },
  start: { from: ['published'], to: 'active' },
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused'], to: 'active' },
  cancel: { from: ['draft', 'published', 'active', 'paused'], to: 'cancelled' },
  finish: { from: ['active', 'paused'], to: 'finished' },
};

/**
 * @openapi
 * tags:
 *   - name: Hunts
 *     description: Hunt drafts and lifecycle
 * components:
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
 *     summary: Rename a draft Hunt
 *     description: Only a Hunt-specific organizer may rename a Hunt, and only while it is a draft. Status cannot be patched.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties: { name: { type: string } }
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
  const keys = Object.keys(req.body);
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (keys.length !== 1 || keys[0] !== 'name' || !name) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  if (hunt.status !== 'draft') return res.status(409).json({ error: 'invalid_hunt_state' });
  const updated = await Hunt.updateDraft(id, name);
  if (!updated) return res.status(409).json({ error: 'invalid_hunt_state' });
  return res.json(updated);
});

/**
 * @openapi
 * /api/hunts/{id}/publish:
 *   post:
 *     tags: [Hunts]
 *     summary: Publish a draft Hunt (draft to published)
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
  const updated = await Hunt.transitionStatus({ id, ...action });
  if (!updated) return res.status(409).json({ error: 'invalid_hunt_state' });
  return res.json(updated);
});

export const huntsRouter = router;
