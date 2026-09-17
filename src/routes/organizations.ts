import express from 'express';
import { requireAuth, requireRole, AuthRequest } from '../middleware/auth.js';
import { Organization } from '../models/Organization.js';

const router = express.Router();

/**
 * @openapi
 * tags:
 *   - name: Organizations
 *     description: Creator organizations
 */

/**
 * @openapi
 * /api/organizations:
 *   post:
 *     tags: [Organizations]
 *     summary: Create organization
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Organization created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Organization' }
 *       400:
 *         description: Missing name
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       403:
 *         description: Only creator accounts may create organizations
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/', requireAuth, requireRole('creator'), async (req: AuthRequest, res) => {
  const user = req.user!;

  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'invalid_input' });

  const org = await Organization.create({ name, description, owner: user.id, members: [user.id] });
  res.status(201).json(org);
});

/**
 * @openapi
 * /api/organizations/{id}:
 *   get:
 *     tags: [Organizations]
 *     summary: Get org details
 *     description: Caller must be the organization's owner or a member.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Organization
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Organization' }
 *       403:
 *         description: Not an owner or member of this organization
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Organization not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const id = String(req.params.id);
  const org = await Organization.findById(id, { populate: true });
  if (!org) return res.status(404).json({ error: 'not_found' });

  const isOwner = String((org.owner as any)?.id ?? org.owner) === String(user.id);
  const isMember = org.members.some(
    (member: any) => String(member?.id ?? member) === String(user.id),
  );
  if (!isOwner && !isMember) return res.status(403).json({ error: 'forbidden' });

  res.json(org);
});

/**
 * @openapi
 * /api/organizations:
 *   get:
 *     tags: [Organizations]
 *     summary: List creator's organizations
 *     description: Returns organizations the caller owns or is a member of.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Organizations
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Organization' }
 */
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const orgs = await Organization.findByOwnerOrMember(user.id);
  res.json(orgs);
});

/**
 * @openapi
 * /api/organizations/{id}:
 *   patch:
 *     tags: [Organizations]
 *     summary: Update org profile
 *     description: Caller must be the organization's owner.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *     responses:
 *       200:
 *         description: Updated organization
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Organization' }
 *       403:
 *         description: Not the owner of this organization
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Organization not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.patch('/:id', requireAuth, requireRole('creator'), async (req: AuthRequest, res) => {
  const user = req.user!;
  const id = String(req.params.id);
  const org = await Organization.findById(id);
  if (!org) return res.status(404).json({ error: 'not_found' });
  if (String(org.owner) !== String(user.id)) return res.status(403).json({ error: 'forbidden' });

  const { name, description } = req.body;
  const updated = await Organization.update(id, { name, description });
  res.json(updated);
});

export const organizationsRouter = router;
