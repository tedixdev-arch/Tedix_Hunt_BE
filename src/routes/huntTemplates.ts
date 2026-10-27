import express from 'express';
import {
  findApprovedHuntTemplateGeography, HuntTemplateGeographyUnavailableError,
  listApprovedHuntTemplates,
} from '../domain/huntTemplates.js';
import { requireAnyRole, requireAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAuth, requireAnyRole(['creator', 'organizer', 'admin']));

/**
 * @openapi
 * /api/hunt-templates:
 *   get:
 *     tags: [Hunt Templates]
 *     summary: List approved runtime-selectable Hunt templates
 *     description: Professional selection catalog. Requires an active non-guest account with an authoritative Creator, Organizer or Admin capability, including multi-role accounts. Returns only key, version, displayName and theme; no geography or challenge answers.
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
 *       403: { description: Guest or no authoritative Creator, Organizer or Admin capability; error is forbidden, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/', async (_req, res, next) => {
  try {
    res.json(await listApprovedHuntTemplates());
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/hunt-templates/{key}/geography:
 *   get:
 *     tags: [Hunt Templates]
 *     summary: Inspect saved geography of the currently approved Template version
 *     description: Read-only professional inspection requires an active non-guest account with an authoritative Creator, Organizer or Admin capability. Multi-role accounts are evaluated using those capabilities, independent of their legacy primary role. Authorization runs before Template lookup, including invalid keys. Creator versions are pinned to submitted_version; approved platform Templates use their latest saved version. Approval is resolved anew on each request, so clients must compare the returned key/version with their catalog selection and reject stale inspection. No client version override is supported. Only saved geographic fields are projected, including an allowlist within each point; no gameplay, answers, scoring or review notes are returned. Missing fields are omitted, partial points and array order are preserved, and a legacy Template with no geography returns configuration {}. No coordinates or defaults are inferred from Signal or gameplay. Malformed present geography returns 409 without repairing saved content. Guests and Participant-only accounts receive 403 forbidden without Template content or existence information.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, description: Exact catalog Template key, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Current approved identity and saved geographic projection (possibly empty or partial)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/HuntTemplateGeography' }
 *       401: { description: Missing or invalid access token, missing user, or blocked/retired account, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       403: { description: Guest or no authoritative Creator, Organizer or Admin capability; error is forbidden, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       404: { description: Template missing, unpublished, or without an authoritative approved version; error is not_found, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: Saved content/configuration is malformed or a present geographic field has an incompatible type; error is template_geography_unavailable, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/:key/geography', async (req, res, next) => {
  try {
    const geography = await findApprovedHuntTemplateGeography(String(req.params.key));
    if (!geography) return res.status(404).json({ error: 'not_found' });
    res.json(geography);
  } catch (error) {
    if (error instanceof HuntTemplateGeographyUnavailableError) {
      return res.status(409).json({ error: 'template_geography_unavailable' });
    }
    next(error);
  }
});

export const huntTemplatesRouter = router;
