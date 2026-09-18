import express, { type Response } from 'express';
import {
  isRewardKind, isRewardProvider, isSpecialAwardDefinition, isVirtualRewardCategory,
} from '../domain/rewards.js';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { Hunt } from '../models/Hunt.js';
import { HuntReward, type RewardDetails } from '../models/HuntReward.js';
import { HuntRoles } from '../models/HuntRole.js';

const router = express.Router({ mergeParams: true });
const commonFields = new Set(['provider', 'kind', 'category', 'name', 'description', 'quantity']);
const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === '23505';

const authorize = async (req: AuthRequest, res: Response, write: boolean) => {
  const huntId = String(req.params.id);
  const hunt = await Hunt.findById(huntId);
  if (!hunt) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const organizer = await HuntRoles.hasRole(huntId, req.user!.id, 'organizer');
  const supervisor = write ? false : await HuntRoles.hasRole(huntId, req.user!.id, 'supervisor');
  if (!organizer && !supervisor) {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }
  if (write && hunt.status !== 'draft') {
    res.status(409).json({ error: 'invalid_hunt_state' });
    return null;
  }
  return hunt;
};

const parseDetails = (values: Record<string, unknown>): RewardDetails | null => {
  if (!isRewardProvider(values.provider) || !isRewardKind(values.kind)
      || !Number.isInteger(values.quantity) || (values.quantity as number) < 1) return null;

  const name = values.name == null ? null : typeof values.name === 'string' ? values.name.trim() : undefined;
  const description = values.description == null
    ? null : typeof values.description === 'string' ? values.description.trim() || null : undefined;
  if (name === undefined || description === undefined) return null;

  if (values.provider === 'organizer') {
    if (!name) return null;
    if (values.category != null && !isVirtualRewardCategory(values.category)) return null;
    return {
      provider: values.provider, kind: values.kind,
      category: values.category ?? null, name, description, quantity: values.quantity as number,
    };
  }
  if (values.kind === 'virtual') {
    if (!isVirtualRewardCategory(values.category)) return null;
    return {
      provider: values.provider, kind: values.kind, category: values.category,
      name: null, description: null, quantity: values.quantity as number,
    };
  }
  return {
    provider: values.provider, kind: values.kind, category: null,
    name: null, description: null, quantity: values.quantity as number,
  };
};

const parseObject = (body: unknown, allowed: Set<string>): Record<string, unknown> | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const values = body as Record<string, unknown>;
  if (Object.keys(values).some((key) => !allowed.has(key))) return null;
  return values;
};

/**
 * @openapi
 * /api/hunts/{id}/rewards:
 *   get:
 *     tags: [Rewards]
 *     summary: Read a Hunt's persisted reward configuration
 *     description: Hunt-specific organizers and supervisors may read rewards. Special-award definition metadata is not duplicated in this response.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     responses:
 *       200: { description: Leaderboard and special award records, content: { application/json: { schema: { $ref: '#/components/schemas/HuntRewards' } } } }
 *       401: { $ref: '#/components/responses/HuntUnauthorized' }
 *       403: { $ref: '#/components/responses/HuntForbidden' }
 *       404: { $ref: '#/components/responses/HuntNotFound' }
 */
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  if (!await authorize(req, res, false)) return;
  return res.json(await HuntReward.list(String(req.params.id)));
});

const leaderboardFields = new Set([...commonFields, 'place']);

/**
 * @openapi
 * /api/hunts/{id}/rewards/leaderboard:
 *   post:
 *     tags: [Rewards]
 *     summary: Add one reward allocation for a leaderboard place
 *     description: Hunt organizer only; the Hunt must be a draft. A place can have one allocation.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/LeaderboardRewardInput' } } } }
 *     responses:
 *       201: { description: Created reward, content: { application/json: { schema: { $ref: '#/components/schemas/LeaderboardReward' } } } }
 *       400: { description: Invalid reward configuration }
 *       409: { description: Hunt is not a draft or the place is already configured }
 */
router.post('/leaderboard', requireAuth, async (req: AuthRequest, res) => {
  if (!await authorize(req, res, true)) return;
  const values = parseObject(req.body, leaderboardFields);
  const details = values && parseDetails(values);
  if (!values || !details || !Number.isInteger(values.place)
      || (values.place as number) < 1 || (values.place as number) > 50) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    const reward = await HuntReward.createLeaderboard(String(req.params.id), values.place as number, details);
    if (!reward) return res.status(409).json({ error: 'invalid_hunt_state' });
    return res.status(201).json(reward);
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: 'reward_conflict' });
    throw error;
  }
});

/**
 * @openapi
 * /api/hunts/{id}/rewards/leaderboard/{rewardId}:
 *   patch:
 *     tags: [Rewards]
 *     summary: Update a draft Hunt leaderboard reward
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: rewardId, required: true, schema: { type: string, format: uuid } }
 *     requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/LeaderboardRewardInput' } } } }
 *     responses: { 200: { description: Updated reward }, 400: { description: Invalid input }, 404: { description: Reward not found }, 409: { description: Invalid Hunt state or place conflict } }
 *   delete:
 *     tags: [Rewards]
 *     summary: Delete a draft Hunt leaderboard reward
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: rewardId, required: true, schema: { type: string, format: uuid } }
 *     responses: { 204: { description: Reward deleted }, 404: { description: Reward not found }, 409: { description: Invalid Hunt state } }
 */
router.patch('/leaderboard/:rewardId', requireAuth, async (req: AuthRequest, res) => {
  if (!await authorize(req, res, true)) return;
  const values = parseObject(req.body, leaderboardFields);
  if (!values || Object.keys(values).length === 0) return res.status(400).json({ error: 'invalid_input' });
  const existing = await HuntReward.findLeaderboard(String(req.params.id), String(req.params.rewardId));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const merged = { ...existing, ...values };
  const details = parseDetails(merged);
  if (!details || !Number.isInteger(merged.place) || merged.place < 1 || merged.place > 50) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    const reward = await HuntReward.updateLeaderboard(existing.huntId, existing.id, merged.place, details);
    if (!reward) return res.status(409).json({ error: 'invalid_hunt_state' });
    return res.json(reward);
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: 'reward_conflict' });
    throw error;
  }
});

router.delete('/leaderboard/:rewardId', requireAuth, async (req: AuthRequest, res) => {
  if (!await authorize(req, res, true)) return;
  const existing = await HuntReward.findLeaderboard(String(req.params.id), String(req.params.rewardId));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!await HuntReward.deleteLeaderboard(existing.huntId, existing.id)) {
    return res.status(409).json({ error: 'invalid_hunt_state' });
  }
  return res.status(204).send();
});

const specialFields = new Set([...commonFields, 'definitionKey']);

/**
 * @openapi
 * /api/hunts/{id}/rewards/special:
 *   post:
 *     tags: [Rewards]
 *     summary: Configure a predefined Special Award on a draft Hunt
 *     description: Hunt organizer only. The definition key must come from reward options and can be configured once per Hunt.
 *     security: [{ bearerAuth: [] }]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string, format: uuid } }]
 *     requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/SpecialAwardInput' } } } }
 *     responses: { 201: { description: Created award }, 400: { description: Invalid configuration }, 409: { description: Invalid Hunt state or definition conflict } }
 */
router.post('/special', requireAuth, async (req: AuthRequest, res) => {
  if (!await authorize(req, res, true)) return;
  const values = parseObject(req.body, specialFields);
  const details = values && parseDetails(values);
  if (!values || !details || !isSpecialAwardDefinition(values.definitionKey)) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    const reward = await HuntReward.createSpecial(String(req.params.id), values.definitionKey, details);
    if (!reward) return res.status(409).json({ error: 'invalid_hunt_state' });
    return res.status(201).json(reward);
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: 'reward_conflict' });
    throw error;
  }
});

/**
 * @openapi
 * /api/hunts/{id}/rewards/special/{rewardId}:
 *   patch:
 *     tags: [Rewards]
 *     summary: Update a predefined Special Award reward on a draft Hunt
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: rewardId, required: true, schema: { type: string, format: uuid } }
 *     requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/SpecialAwardInput' } } } }
 *     responses: { 200: { description: Updated award }, 400: { description: Invalid configuration }, 404: { description: Award not found }, 409: { description: Invalid Hunt state or definition conflict } }
 *   delete:
 *     tags: [Rewards]
 *     summary: Delete a Special Award configuration from a draft Hunt
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: rewardId, required: true, schema: { type: string, format: uuid } }
 *     responses: { 204: { description: Award deleted }, 404: { description: Award not found }, 409: { description: Invalid Hunt state } }
 */
router.patch('/special/:rewardId', requireAuth, async (req: AuthRequest, res) => {
  if (!await authorize(req, res, true)) return;
  const values = parseObject(req.body, specialFields);
  if (!values || Object.keys(values).length === 0) return res.status(400).json({ error: 'invalid_input' });
  const existing = await HuntReward.findSpecial(String(req.params.id), String(req.params.rewardId));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const merged = { ...existing, ...values };
  const details = parseDetails(merged);
  if (!details || !isSpecialAwardDefinition(merged.definitionKey)) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    const reward = await HuntReward.updateSpecial(existing.huntId, existing.id, merged.definitionKey, details);
    if (!reward) return res.status(409).json({ error: 'invalid_hunt_state' });
    return res.json(reward);
  } catch (error) {
    if (isUniqueViolation(error)) return res.status(409).json({ error: 'reward_conflict' });
    throw error;
  }
});

router.delete('/special/:rewardId', requireAuth, async (req: AuthRequest, res) => {
  if (!await authorize(req, res, true)) return;
  const existing = await HuntReward.findSpecial(String(req.params.id), String(req.params.rewardId));
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!await HuntReward.deleteSpecial(existing.huntId, existing.id)) {
    return res.status(409).json({ error: 'invalid_hunt_state' });
  }
  return res.status(204).send();
});

export const huntRewardsRouter = router;
