import express from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { HuntContext } from '../models/HuntContext.js';

const router = express.Router();

/**
 * @openapi
 * /api/me/hunt-contexts:
 *   get:
 *     tags: [Me]
 *     summary: List the authenticated user's Hunt contexts
 *     description: Participant and supervisor flags reflect Hunt-specific access and may both be true for one Hunt.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Hunt contexts ordered by useful status, most recently updated, and then created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [contexts]
 *               properties:
 *                 contexts:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/HuntContext' }
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/hunt-contexts', requireAuth, async (req: AuthRequest, res) => {
  const contexts = await HuntContext.findForUser(req.user!.id);
  return res.json({ contexts });
});

export { router as meRouter };
