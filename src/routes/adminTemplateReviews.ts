import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { HuntTemplateNotReviewableError, HuntTemplates } from '../models/HuntTemplate.js';

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
 *     description: Admin-only. Approves the exact immutable submitted_version without creating a version, making that artifact available for Organizer catalog selection and Hunt snapshotting.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Exact approved immutable artifact, content: { application/json: { schema: { $ref: '#/components/schemas/AdminTemplateReview' } } } }
 *       401: { description: Authentication required }
 *       403: { description: Authoritative Admin capability required }
 *       404: { description: Creator Template key not found }
 *       409: { description: Creator Template is not currently reviewable }
 */
router.post('/:key/approve', requireAuth, requireRole('admin'), async (request, response, next) => {
  try {
    const key = request.params.key;
    if (typeof key !== 'string') return response.status(404).json({ error: 'not_found' });
    const approved = await HuntTemplates.approveSubmittedCreator(key);
    return approved
      ? response.json(approved)
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
 * /api/admin/templates/review/{key}/request-changes:
 *   post:
 *     tags: [Admin Template Review]
 *     summary: Request changes to a submitted Creator Template
 *     description: Admin-only. Changes status to changes_requested for the exact immutable submitted_version and preserves that pin. It neither mutates nor creates a Template version, does not publish the Template, and does not implement Creator revision or resubmission.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Exact immutable artifact for which changes were requested, content: { application/json: { schema: { $ref: '#/components/schemas/AdminTemplateReview' } } } }
 *       401: { description: Authentication required }
 *       403: { description: Authoritative Admin capability required }
 *       404: { description: Creator Template key not found }
 *       409: { description: Creator Template is not currently reviewable }
 */
router.post('/:key/request-changes', requireAuth, requireRole('admin'), async (request, response, next) => {
  try {
    const key = request.params.key;
    if (typeof key !== 'string') return response.status(404).json({ error: 'not_found' });
    const template = await HuntTemplates.requestChangesForSubmittedCreator(key);
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
