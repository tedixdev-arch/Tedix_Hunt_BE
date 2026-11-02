import { TokenBuckets, networkIdentity } from '../middleware/abuseProtection.js';
import express from 'express';
import { normalizeHuntAccessCode } from '../domain/huntAccess.js';
import { Hunt } from '../models/Hunt.js';

const lookupBuckets = new TokenBuckets(10000);
const router = express.Router();

/**
 * @openapi
 * /api/hunt-access/{code}:
 *   get:
 *     tags: [Hunts]
 *     summary: Resolve a participant access code
 *     description: Public endpoint returning only the Hunt identity and current lifecycle status. It does not enroll a participant.
 *     parameters: [{ in: path, name: code, required: true, schema: { type: string, pattern: '^[A-HJ-NP-Z2-9]{8}$', example: 7KPM4XQ2 } }]
 *     responses:
 *       200:
 *         description: Minimal public Hunt identity and status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/HuntAccessResolution' } } }
 *       404: { description: Invalid or unknown access code, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 */
router.get('/:code', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const retry = lookupBuckets.consume(networkIdentity(req.ip ?? 'unknown'), { capacity: 120, windowMs: 60000 });
  if (retry) { res.set('Retry-After', String(retry)); return res.status(429).json({ error: 'rate_limited' }); }
  const code = normalizeHuntAccessCode(String(req.params.code));
  if (!code) return res.status(404).json({ error: 'not_found' });
  const hunt = await Hunt.findByAccessCode(code);
  if (!hunt) return res.status(404).json({ error: 'not_found' });
  return res.json({ huntId: hunt.id, code, name: hunt.name, status: hunt.status });
});

export const huntAccessRouter = router;
