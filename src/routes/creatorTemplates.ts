import express from 'express';
import { isTemplateContentV1, normalizeTemplateKey } from '../domain/creatorTemplates.js';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { HuntTemplateKeyConflictError, HuntTemplates } from '../models/HuntTemplate.js';

const router = express.Router();

/**
 * @openapi
 * /api/creator/templates:
 *   post:
 *     tags: [Creator Templates]
 *     summary: Create a draft Competition Template with immutable version 1
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, content]
 *             properties:
 *               key: { type: string, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }
 *               content: { $ref: '#/components/schemas/CreatorTemplateContent' }
 *     responses:
 *       201: { description: Draft Template and version 1 created }
 *       400: { description: Invalid Template content, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: Template key already exists, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/', requireAuth, requireRole('creator'), async (req: AuthRequest, res, next) => {
  const key = normalizeTemplateKey(req.body?.key);
  if (!key || !isTemplateContentV1(req.body?.content, key)) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  try {
    // Authorization uses authoritative user_roles materialized on the authenticated identity.
    const result = await HuntTemplates.createCreatorDraft(key, req.body.content, req.user!.id);
    return res.status(201).json({
      key: result.template.key,
      version: result.version.version,
      status: result.template.status,
      origin: result.template.origin,
      content: result.version.content,
    });
  } catch (error) {
    if (error instanceof HuntTemplateKeyConflictError) {
      return res.status(409).json({ error: 'template_key_conflict' });
    }
    return next(error);
  }
});

export const creatorTemplatesRouter = router;
