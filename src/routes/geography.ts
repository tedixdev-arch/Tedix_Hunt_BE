import { Router } from 'express';
import { requireAuth, requireAnyRole } from '../middleware/auth.js';
import { Geography } from '../models/Geography.js';

const router = Router();
router.use(requireAuth, requireAnyRole(['creator', 'organizer', 'admin']));

/**
 * @openapi
 * /api/geography/countries:
 *   get:
 *     tags: [Geography]
 *     summary: List stored country references (Creator, Organizer or Admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Object containing countries (code and displayName) }
 *       401: { description: Authentication required }
 *       403: { description: Professional capability required }
 * /api/geography/localities:
 *   get:
 *     tags: [Geography]
 *     summary: Search active stored localities; no external provider
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: countryCode, required: true, schema: { type: string, pattern: '^[A-Z]{2}$' } }
 *       - { in: query, name: q, required: true, schema: { type: string, minLength: 1, maxLength: 100 } }
 *     responses:
 *       200: { description: Up to 50 catalog records and providerStatus not_requested }
 *       400: { description: Invalid input or unsupported country/parameter }
 *       401: { description: Authentication required }
 *       403: { description: Professional capability required }
 * /api/geography/localities/{id}:
 *   get:
 *     tags: [Geography]
 *     summary: Resolve exact stored UUID, including inactive records
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Catalog fields including active flag; excludes internal provenance/provider metadata }
 *       400: { description: Invalid UUID }
 *       401: { description: Authentication required }
 *       403: { description: Professional capability required }
 *       404: { description: Locality not found }
 */
router.get('/countries', async (_req, res, next) => {
  try { return res.json({ countries: await Geography.countries() }); }
  catch (error) { return next(error); }
});

router.get('/localities', async (req, res, next) => {
  const { countryCode, q } = req.query;
  if (Object.keys(req.query).some(key => !['countryCode', 'q'].includes(key)) ||
      typeof countryCode !== 'string' || !/^[A-Z]{2}$/.test(countryCode) ||
      typeof q !== 'string' || q.trim().length < 1 || q.length > 100) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    if (!(await Geography.countries()).some(country => country.code === countryCode)) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    return res.json({ localities: await Geography.search(countryCode, q.trim()), providerStatus: 'not_requested' });
  } catch (error) { return next(error); }
});

router.get('/localities/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  try {
    const locality = await Geography.findById(id);
    return locality ? res.json(locality) : res.status(404).json({ error: 'not_found' });
  } catch (error) { return next(error); }
});

export const geographyRouter = router;
