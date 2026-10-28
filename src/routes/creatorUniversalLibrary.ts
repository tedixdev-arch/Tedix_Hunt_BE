import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { PublishedUniversals } from '../models/PublishedUniversal.js';

const router = Router();

/**
 * @openapi
 * /api/creator/universal-library:
 *   get:
 *     tags: [Creator Templates]
 *     summary: Discover one published product per independently approved Universal
 *     description: Persisted active non-guest Creator capability required. Returns id, key, displayName, theme, creator (id/name only), and publishedReference (templateId/version). No drafts, review notes, email, content or version history. Universal approval does not certify a route or enable Organizer selection.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Object containing items array of published Universal products }
 *       401: { description: Authentication required }
 *       403: { description: Creator capability required }
 * /api/creator/universal-library/{key}:
 *   get:
 *     tags: [Creator Templates]
 *     summary: Read the currently published Universal artifact
 *     description: Same safe product metadata as the list plus the exact approved content. Read-only; no copy operation or historical version selection. publishedReference is an exact artifact identity, not a request to select an older version.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: key, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Published Universal product and exact approved content }
 *       401: { description: Authentication required }
 *       403: { description: Creator capability required }
 *       404: { description: No published Universal at this key }
 */
router.get('/', requireAuth, requireRole('creator'), async (_req, res, next) => {
  try {
    return res.json({ items: await PublishedUniversals.list() });
  } catch (error) { return next(error); }
});

router.get('/:key', requireAuth, requireRole('creator'), async (req, res, next) => {
  try {
    const key = req.params.key;
    if (typeof key !== 'string') return res.status(404).json({ error: 'not_found' });
    const product = await PublishedUniversals.findByKey(key);
    return product ? res.json(product) : res.status(404).json({ error: 'not_found' });
  } catch (error) { return next(error); }
});

export const creatorUniversalLibraryRouter = router;
