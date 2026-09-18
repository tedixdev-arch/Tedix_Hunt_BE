import express from 'express';
import { rewardOptions } from '../domain/rewards.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * @openapi
 * /api/reward-options:
 *   get:
 *     tags: [Rewards]
 *     summary: List Organizer reward configuration options
 *     description: Backend-controlled provider, kind, virtual category, and special-award metadata. Physical inventory identities and quantities are not exposed.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Reward configuration metadata, content: { application/json: { schema: { $ref: '#/components/schemas/RewardOptions' } } } }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (_req, res) => res.json(rewardOptions));

export const rewardOptionsRouter = router;
