import express from 'express';
import { huntOptions } from '../domain/huntOptions.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * @openapi
 * /api/hunt-options:
 *   get:
 *     tags: [Hunt Options]
 *     summary: List Hunt setup choices
 *     description: Solo and Team are setup choices, not live gameplay capabilities. teamSizes lists the historical pilot choice; variable-size configuration is accepted by Hunt PATCH while publication remains gated on D2/D5.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Hunt setup options
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HuntOptions' }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (_req, res) => res.json(huntOptions));

export const huntOptionsRouter = router;
