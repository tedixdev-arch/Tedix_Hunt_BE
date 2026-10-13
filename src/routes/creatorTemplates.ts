import express from 'express';
import { randomUUID } from 'node:crypto';
import { isTemplateContentV1, normalizeTemplateKey } from '../domain/creatorTemplates.js';
import { createSignalClujNapocaStarter } from '../domain/templates/signalClujNapocaStarter.js';
import { createSignalOverloadClujNapocaStarter } from '../domain/templates/signalOverloadClujNapocaStarter.js';
import { listStarterCatalog } from '../domain/templates/starterCatalog.js';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import {
  HuntTemplateNotDeletableError, HuntTemplateInUseError, HuntTemplateKeyConflictError, HuntTemplateNotEditableError, HuntTemplateNotFoundError,
  HuntTemplateNotSubmittableError, HuntTemplates, HuntTemplateVersionNotLatestError,
  InvalidHuntTemplateContentError,
} from '../models/HuntTemplate.js';

const router = express.Router();

/**
 * @openapi
 * /api/creator/templates/starters:
 *   get:
 *     tags: [Creator Templates]
 *     summary: List available Creator starter Templates
 *     description: Read-only fixed starter registry. Known creation dates sort newest first, unknown dates last, with ascending stable key as tie-breaker. Both current starter dates are unknown. Dates describe verified starter creation or registration, never platform installation or Creator copying. No private drafts are included.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Available starters in deterministic creation-date order
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [items]
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [key, displayName, description, createdAt, creationPath]
 *                     properties:
 *                       key: { type: string, description: Stable source identity }
 *                       displayName: { type: string }
 *                       description: { type: string }
 *                       createdAt: { type: string, format: date-time, nullable: true, description: Verified starter creation or registration time; null when unknown }
 *                       creationPath: { type: string, description: Existing POST endpoint for creating an ordinary Creator-owned draft }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/starters', requireAuth, requireRole('creator'), (_req, res) => {
  return res.json({ items: listStarterCatalog() });
});

/**
 * @openapi
 * /api/creator/templates/starters/signal-cluj-napoca:
 *   post:
 *     tags: [Creator Templates]
 *     summary: Create a Creator-owned Signal Cluj geographic draft starter
 *     description: Copies canonical Signal v1 server-side into six normal gameplay entries and one unnumbered terminal FinishPoint entry. Preserves all puzzles, story and scoring. Fictional route clues are stored in fictionalNavigation with scope=puzzle-only; they are not real walking instructions. Route research and physical verification are pending; positions are empty and geographic finishPoint is omitted. The ordinary version-1 draft must be edited with researched geography before existing submission/review. Ownership comes from the authenticated Creator; no approval or publishing occurs. Omit key for a unique generated key, or supply a key for the existing 409 conflict behavior.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               key: { type: string, maxLength: 100, description: Normalized with the existing Creator key rules }
 *     responses:
 *       201: { description: Ordinary Creator-owned draft and immutable version 1 created }
 *       400: { description: Invalid starter input, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: Template key already exists, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/starters/signal-cluj-napoca', requireAuth, requireRole('creator'), async (req: AuthRequest, res, next) => {
  const body = req.body;
  if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body)
    || Object.keys(body).some((field) => field !== 'key'))) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const key = body?.key === undefined
    ? `signal-cluj-napoca-${randomUUID()}` : normalizeTemplateKey(body.key);
  if (!key) return res.status(400).json({ error: 'invalid_input' });
  const content = createSignalClujNapocaStarter(key);
  if (!isTemplateContentV1(content, key)) return next(new InvalidHuntTemplateContentError());

  try {
    const result = await HuntTemplates.createCreatorDraft(key, content, req.user!.id);
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
 * /api/creator/templates/starters/signal-overload-cluj-napoca:
 *   post:
 *     tags: [Creator Templates]
 *     summary: Create a Creator-owned Signal Overload Cluj Napoca draft starter
 *     description: Copies the separate Signal Overload v1 definition into an ordinary Creator-owned draft. Six normal entries and one terminal FinishPoint follow the reversed landmark research sequence while preserving puzzle and scoring order. Diagnostic-grid directions are puzzle content only. Geographic positions are empty and finishPoint is omitted pending field verification. No submission, approval, publication or Hunt changes occur. Omit key for a unique generated key; existing keys return 409 without replacement.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               key: { type: string, maxLength: 100, description: Normalized with the existing Creator key rules }
 *     responses:
 *       201: { description: Ordinary Creator-owned draft and immutable version 1 created }
 *       400: { description: Invalid starter input, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: Template key already exists, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.post('/starters/signal-overload-cluj-napoca', requireAuth, requireRole('creator'), async (req: AuthRequest, res, next) => {
  const body = req.body;
  if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body)
    || Object.keys(body).some((field) => field !== 'key'))) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const key = body?.key === undefined
    ? `signal-overload-cluj-napoca-${randomUUID()}` : normalizeTemplateKey(body.key);
  if (!key) return res.status(400).json({ error: 'invalid_input' });
  const content = createSignalOverloadClujNapocaStarter(key);
  if (!isTemplateContentV1(content, key)) return next(new InvalidHuntTemplateContentError());

  try {
    const result = await HuntTemplates.createCreatorDraft(key, content, req.user!.id);
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
 *   delete:
 *     tags: [Creator Templates]
 *     summary: Permanently delete an unused Creator-owned draft Template
 *     description: Only draft or changes_requested Templates owned by the authenticated Creator may be deleted. Removes all associated versions transactionally. Any Hunt reference or protected foreign-key dependency prevents deletion. Submitted and approved Templates are immutable. Missing, other-owned and platform keys (including repeated deletion) return the same 404.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     responses:
 *       204: { description: Template and associated unused versions permanently deleted }
 *       401: { description: Authentication required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Creator capability required, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       404: { description: Template not found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: template_not_deletable or template_in_use, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.delete('/:key', requireAuth, requireRole('creator'), async (req: AuthRequest, res, next) => {
  const key = req.params.key;
  if (typeof key !== 'string') return res.status(404).json({ error: 'not_found' });
  try {
    await HuntTemplates.deleteCreatorDraft(key, req.user!.id);
    return res.status(204).end();
  } catch (error) {
    if (error instanceof HuntTemplateNotFoundError) return res.status(404).json({ error: 'not_found' });
    if (error instanceof HuntTemplateNotDeletableError) {
      return res.status(409).json({ error: 'template_not_deletable' });
    }
    if (error instanceof HuntTemplateInUseError) return res.status(409).json({ error: 'template_in_use' });
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
