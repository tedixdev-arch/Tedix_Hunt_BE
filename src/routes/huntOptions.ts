import express from 'express';
import { huntOptions } from '../domain/huntOptions.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * @openapi
 * /api/hunt-options:
 *   get:
 *     tags: [Hunt Options]
 *     summary: List currently supported pilot runtime options
 *     description: Returns only values supported by the current pilot runtime; unsupported prototype choices are intentionally omitted.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Supported pilot Hunt options
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HuntOptions' }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (_req, res) => res.json(huntOptions));

export const huntOptionsRouter = router;
