import express from 'express';
import { listHuntTemplates } from '../domain/huntTemplates.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * @openapi
 * /api/hunt-templates:
 *   get:
 *     tags: [Hunt Templates]
 *     summary: List approved runtime-selectable Hunt templates
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Approved template metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/HuntTemplateMetadata' }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, (_req, res) => res.json(listHuntTemplates()));

export const huntTemplatesRouter = router;
