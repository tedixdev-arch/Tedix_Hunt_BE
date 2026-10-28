import express from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { HuntTemplateNotReviewableError, HuntTemplateSelfApprovalError, HuntTemplates } from '../models/HuntTemplate.js';

const router = express.Router();

/**
 * @openapi
 * /api/admin/templates/review:
 *   get:
 *     tags: [Admin Template Review]
 *     summary: List submitted Creator Templates awaiting review
 *     description: Admin-only, read-only queue. Each result is the exact immutable version referenced by submitted_version, never an implicit latest version.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Submitted Creator Template review artifacts
 *         content: { application/json: { schema: { type: object, required: [templates], properties: { templates: { type: array, items: { $ref: '#/components/schemas/AdminTemplateReview' } } } } } }
 *       401: { description: Authentication required }
 *       403: { description: Authoritative Admin capability required }
 */
router.get('/', requireAuth, requireRole('admin'), async (_request, response, next) => {
  try {
    return response.json({ templates: await HuntTemplates.listSubmittedCreatorReviews() });
  } catch (error) {
    return next(error);
  }
});

/**
 * @openapi
 * /api/admin/templates/review/{key}/approve:
 *   post:
 *     tags: [Admin Template Review]
 *     summary: Approve a submitted Creator Template
 *     description: Admin-only; the reviewing Admin must differ from the Creator. Records reviewer, version, decision and time atomically. Approves the exact immutable submitted_version without creating a version. Classified decisions require body version matching the inspected candidate; stale or missing versions return 409. Universal approval atomically replaces the published artifact. Classified Organizer selection remains closed.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { version: { type: integer, minimum: 1, description: Required for classified Templates; exact inspected version } } } } }
 *     responses:
 *       400: { description: Invalid decision body }
 *       200: { description: Exact approved immutable artifact, content: { application/json: { schema: { $ref: '#/components/schemas/AdminTemplateReview' } } } }
 *       401: { description: Authentication required }
 *       403: { description: Authoritative Admin capability required; self-approval forbidden }
 *       404: { description: Creator Template key not found }
 *       409: { description: Creator Template is not currently reviewable }
 */
router.post('/:key/approve', requireAuth, requireRole('admin'), async (request: AuthRequest, response, next) => {
  try {
    const key = request.params.key;
    if (typeof key !== 'string') return response.status(404).json({ error: 'not_found' });
    const body = request.body;
    if (body != null && (typeof body !== 'object' || Array.isArray(body)
      || (body.version !== undefined && (!Number.isInteger(body.version) || body.version < 1)))) {
      return response.status(400).json({ error: 'invalid_input' });
    }
    const approved = await HuntTemplates.approveSubmittedCreator(
      key, request.user!.id, ...(body?.version === undefined ? [] : [body.version]),
    );
    return approved
      ? response.json(approved)
      : response.status(404).json({ error: 'not_found' });
  } catch (error) {
    if (error instanceof HuntTemplateSelfApprovalError) {
      return response.status(403).json({ error: 'template_self_approval_forbidden' });
    }
    if (error instanceof HuntTemplateNotReviewableError) {
      return response.status(409).json({ error: 'template_not_reviewable' });
    }
    return next(error);
  }
});

/**
 * @openapi
 * /api/admin/templates/review/{key}/request-changes:
 *   post:
 *     tags: [Admin Template Review]
 *     summary: Request changes to a submitted Creator Template
 *     description: Admin-only. Records reviewer, version, decision and time atomically. Self-request-changes remains allowed. Changes status to changes_requested for the exact immutable submitted_version and preserves that pin. It neither mutates nor creates a Template version, preserves the previous Universal publication. Classified decisions require body version matching the inspected candidate; stale or missing versions return 409. The owner can save a new immutable correction and resubmit.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     requestBody:
 *       content: { application/json: { schema: { type: object, properties: { version: { type: integer, minimum: 1, description: Required for classified Templates; exact inspected version } } } } }
 *     responses:
 *       400: { description: Invalid decision body }
 *       200: { description: Exact immutable artifact for which changes were requested, content: { application/json: { schema: { $ref: '#/components/schemas/AdminTemplateReview' } } } }
 *       401: { description: Authentication required }
 *       403: { description: Authoritative Admin capability required }
 *       404: { description: Creator Template key not found }
 *       409: { description: Creator Template is not currently reviewable }
 */
router.post('/:key/request-changes', requireAuth, requireRole('admin'), async (request: AuthRequest, response, next) => {
  try {
    const key = request.params.key;
    if (typeof key !== 'string') return response.status(404).json({ error: 'not_found' });
    const body = request.body;
    if (body != null && (typeof body !== 'object' || Array.isArray(body)
      || (body.version !== undefined && (!Number.isInteger(body.version) || body.version < 1)))) {
      return response.status(400).json({ error: 'invalid_input' });
    }
    const template = await HuntTemplates.requestChangesForSubmittedCreator(
      key, request.user!.id, ...(body?.version === undefined ? [] : [body.version]),
    );
    return template
      ? response.json(template)
      : response.status(404).json({ error: 'not_found' });
  } catch (error) {
    if (error instanceof HuntTemplateNotReviewableError) {
      return response.status(409).json({ error: 'template_not_reviewable' });
    }
    return next(error);
  }
});

/**
 * @openapi
 * /api/admin/templates/review/{key}:
 *   get:
 *     tags: [Admin Template Review]
 *     summary: Inspect one submitted Creator Template
 *     description: Admin-only, read-only inspection of the exact immutable version referenced by submitted_version, never an implicit latest version.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Exact submitted review artifact, content: { application/json: { schema: { $ref: '#/components/schemas/AdminTemplateReview' } } } }
 *       401: { description: Authentication required }
 *       403: { description: Authoritative Admin capability required }
 *       404: { description: Key is not in the submitted Creator review queue }
 */
router.get('/:key', requireAuth, requireRole('admin'), async (request, response, next) => {
  try {
    const key = request.params.key;
    if (typeof key !== 'string') return response.status(404).json({ error: 'not_found' });
    const template = await HuntTemplates.findSubmittedCreatorReviewByKey(key);
    return template
      ? response.json(template)
      : response.status(404).json({ error: 'not_found' });
  } catch (error) {
    return next(error);
  }
});

export { router as adminTemplateReviewsRouter };
