import express from 'express';
import { isTemplateContentV1, normalizeTemplateKey } from '../domain/creatorTemplates.js';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import {
  HuntTemplateKeyConflictError, HuntTemplateNotEditableError, HuntTemplateNotFoundError,
  HuntTemplateNotSubmittableError, HuntTemplates, HuntTemplateVersionNotLatestError,
  InvalidHuntTemplateContentError,
} from '../models/HuntTemplate.js';

const router = express.Router();

/**
 * @openapi
 * /api/creator/templates:
 *   get:
 *     tags: [Creator Templates]
 *     summary: List the authenticated Creator's own authoring Templates
 *     description: Owner-scoped authoring read across all lifecycle states; unlike the approved discovery catalog, platform and other Creators' Templates are excluded.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Creator-owned Templates with their latest persisted versions
 *         content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/CreatorOwnedTemplate' } } } }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', requireAuth, requireRole('creator'), async (req: AuthRequest, res, next) => {
  try {
    // The model applies creator provenance and ownership before PostgreSQL returns rows.
    return res.json(await HuntTemplates.listCreatorOwnedWithLatestVersion(req.user!.id));
  } catch (error) {
    return next(error);
  }
});

/**
 * @openapi
 * /api/creator/templates/{key}:
 *   get:
 *     tags: [Creator Templates]
 *     summary: Read one of the authenticated Creator's own authoring Templates
 *     description: Returns the latest persisted version in any lifecycle state. Missing and other-owned keys are indistinguishable.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Creator-owned Template, content: { application/json: { schema: { $ref: '#/components/schemas/CreatorOwnedTemplate' } } } }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       404: { description: Template not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/:key', requireAuth, requireRole('creator'), async (req: AuthRequest, res, next) => {
  try {
    const key = req.params.key;
    if (typeof key !== 'string') return res.status(404).json({ error: 'not_found' });
    const template = await HuntTemplates.findCreatorOwnedByKeyWithLatestVersion(
      key,
      req.user!.id,
    );
    // Deliberately identical for unknown and other-owned keys to avoid disclosing private work.
    return template ? res.json(template) : res.status(404).json({ error: 'not_found' });
  } catch (error) {
    return next(error);
  }
});

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

/**
 * @openapi
 * /api/creator/templates/{key}/versions:
 *   post:
 *     tags: [Creator Templates]
 *     summary: Save a new immutable version of a Creator-owned draft Template
 *     description: The complete Template snapshot must be supplied. The backend calculates the next version; only the authenticated Creator's own draft Templates are editable.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content: { $ref: '#/components/schemas/CreatorTemplateContent' }
 *     responses:
 *       201: { description: New immutable Template version created }
 *       400: { description: Invalid complete Template content, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       404: { description: Template not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: Creator-owned Template is not editable, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/:key/versions', requireAuth, requireRole('creator'), async (req: AuthRequest, res, next) => {
  const key = req.params.key;
  if (typeof key !== 'string') return res.status(404).json({ error: 'not_found' });
  try {
    const result = await HuntTemplates.createCreatorVersion(key, req.body?.content, req.user!.id);
    return res.status(201).json({
      key: result.template.key,
      version: result.version.version,
      status: result.template.status,
      origin: result.template.origin,
      content: result.version.content,
    });
  } catch (error) {
    // Missing and other-owned identities deliberately share one response.
    if (error instanceof HuntTemplateNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (error instanceof HuntTemplateNotEditableError) {
      return res.status(409).json({ error: 'template_not_editable' });
    }
    if (error instanceof InvalidHuntTemplateContentError) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    return next(error);
  }
});

/**
 * @openapi
 * /api/creator/templates/{key}/submit:
 *   post:
 *     tags: [Creator Templates]
 *     summary: Submit an exact immutable Template version for Admin review
 *     description: Only the authenticated Creator's own draft Template may be submitted, and the explicitly supplied version must be its latest persisted version. Geographic normal-checkpoint configuration requires all normal positions, one complete FinishPoint and exactly one shared gameplay entry with role=terminal; legacy non-geographic content remains supported. Submission does not approve or publish the Template.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [version]
 *             properties:
 *               version: { type: integer, minimum: 1 }
 *     responses:
 *       200: { description: Exact immutable version submitted for review, content: { application/json: { schema: { $ref: '#/components/schemas/CreatorOwnedTemplate' } } } }
 *       400: { description: Invalid version, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       404: { description: Template not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: Template is not a draft or version is not latest, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/:key/submit', requireAuth, requireRole('creator'), async (req: AuthRequest, res, next) => {
  const key = req.params.key;
  const version = req.body?.version;
  if (typeof key !== 'string') return res.status(404).json({ error: 'not_found' });
  if (!Number.isInteger(version) || version < 1) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  try {
    const result = await HuntTemplates.submitCreatorDraft(key, version, req.user!.id);
    return res.json({
      key: result.template.key,
      version: result.version.version,
      status: result.template.status,
      origin: result.template.origin,
      content: result.version.content,
    });
  } catch (error) {
    // Unknown, other-owned, and platform keys are deliberately indistinguishable.
    if (error instanceof HuntTemplateNotFoundError) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (error instanceof HuntTemplateVersionNotLatestError) {
      return res.status(409).json({ error: 'template_version_not_latest' });
    }
    if (error instanceof HuntTemplateNotSubmittableError) {
      return res.status(409).json({ error: 'template_not_submittable' });
    }
    if (error instanceof InvalidHuntTemplateContentError) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    return next(error);
  }
});

export const creatorTemplatesRouter = router;
