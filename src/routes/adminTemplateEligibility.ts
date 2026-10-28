import express from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { HuntTemplates, HuntTemplateNotFoundError, TemplateEligibilityConflictError, TemplateLocalityError } from '../models/HuntTemplate.js';

const router = express.Router();
/**
 * @openapi
 * /api/admin/templates/{key}/suspend:
 *   post:
 *     tags: [Admin Template Review]
 *     summary: Suspend exact Local approval authority once, preserving all approval history
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [version, reason]
 *             properties:
 *               version: { type: integer, minimum: 1 }
 *               reason: { type: string, minLength: 1, maxLength: 1000 }
 *     responses:
 *       200: { description: Immutable suspension audit tuple }
 *       400: { description: invalid_input }
 *       401: { description: Authentication required }
 *       403: { description: Active authoritative Admin capability required }
 *       404: { description: Unknown or platform key }
 *       409: { description: template_eligibility_conflict; stale, missing, non-Local or already suspended authority }
 */
router.post('/:key/suspend', requireAuth, requireRole('admin'), async (req: AuthRequest, res, next) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(field => !['version', 'reason'].includes(field))
    || !Number.isSafeInteger(body.version) || body.version < 1 || body.version > 2147483647
    || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    return res.json(await HuntTemplates.suspendLocal(req.params.key as string, body.version, req.user!.id, body.reason));
  } catch (error) {
    if (error instanceof HuntTemplateNotFoundError) return res.status(404).json({ error: 'not_found' });
    if (error instanceof TemplateEligibilityConflictError) return res.status(409).json({ error: 'template_eligibility_conflict' });
    if (error instanceof TemplateLocalityError) return res.status(error.status).json({ error: error.code });
    return next(error);
  }
});
export const adminTemplateEligibilityRouter = router;
