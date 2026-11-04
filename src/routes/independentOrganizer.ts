import crypto from 'node:crypto';
import express from 'express';
import { pool } from '../lib/postgres.js';
import { environment } from '../config/environment.js';
import { normalizeEmail, User } from '../models/User.js';
import { TokenBuckets } from '../middleware/abuseProtection.js';
import { createTokens } from './auth.js';

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const buckets = new TokenBuckets(10000);
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const limited = (key: string, capacity: number, windowMs: number, res: express.Response) => {
  const retry = buckets.consume(key, { capacity, windowMs });
  if (retry) { res.set('Retry-After', String(retry)); res.status(429).json({ error: 'rate_limited' }); }
  return !!retry;
};

/**
 * @openapi
 * /api/auth/independent-organizer/request-code:
 *   post:
 *     tags: [Auth]
 *     summary: Send an Independent Organizer email confirmation code
 *     description: No email provider is configured yet, so this returns 503 email_delivery_unavailable. Only a local developer machine that sets INDEPENDENT_ORGANIZER_DEV_CODES=true (never a shared or deployed server) receives the code as devCode.
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [email], properties: { email: { type: string, format: email } } } } }
 *     responses:
 *       202: { description: Code issued }
 *       400: { description: Invalid email }
 *       503: { description: Email delivery is not configured }
 * /api/auth/independent-organizer/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Confirm the code and sign in as an Independent Organizer
 *     description: Creates the account and a personal Independent organization on first use. Independent organizations cannot configure rewards. Email codes never sign in to an account that has a password or a role other than Organizer; those use their normal sign-in.
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [email, code], properties: { email: { type: string }, code: { type: string, pattern: '^[0-9]{6}$' }, name: { type: string, maxLength: 80 } } } } }
 *     responses:
 *       200: { description: Signed in with access and refresh tokens }
 *       400: { description: Invalid input or code }
 *       403: { description: Account is blocked or retired }
 *       409: { description: The email belongs to a password or multi-role account; use the normal sign-in }
 */
export const independentOrganizerRouter = express.Router();

independentOrganizerRouter.post('/request-code', async (req, res) => {
  const body = req.body;
  if (!record(body) || typeof body.email !== 'string' || !email.test(body.email.trim()) || body.email.length > 254) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const address = normalizeEmail(body.email);
  if (limited(`ip:${req.ip}`, 20, 60 * 60 * 1000, res) || limited(`email:${address}`, 5, 15 * 60 * 1000, res)) return;
  // Returning the code would let anyone sign in as any email, so this is opt-in for a local machine only.
  const devCodes = process.env.INDEPENDENT_ORGANIZER_DEV_CODES === 'true' && environment.nodeEnv !== 'production';
  if (!devCodes) return res.status(503).json({ error: 'email_delivery_unavailable' });
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await pool.query(`INSERT INTO email_verification_codes(email,purpose,code_hash,expires_at) VALUES($1,'independent_organizer',$2,$3)`,
    [address, hash(`${address}:${code}`), new Date(Date.now() + CODE_TTL_MS)]);
  return res.status(202).json({ sent: true, expiresInSeconds: CODE_TTL_MS / 1000, devCode: code });
});

independentOrganizerRouter.post('/verify', async (req, res) => {
  const body = req.body;
  if (!record(body) || typeof body.email !== 'string' || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)
    || (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 80))) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const address = normalizeEmail(body.email);
  if (limited(`verify:${address}`, 10, 15 * 60 * 1000, res)) return;
  const client = await pool.connect();
  let userId: string;
  try {
    await client.query('BEGIN');
    const { rows: codes } = await client.query(`SELECT * FROM email_verification_codes WHERE email=$1 AND purpose='independent_organizer'
      AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [address]);
    const entry = codes[0];
    if (!entry || entry.expires_at < new Date() || entry.attempts >= MAX_ATTEMPTS) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'invalid_code' });
    }
    if (!crypto.timingSafeEqual(Buffer.from(entry.code_hash), Buffer.from(hash(`${address}:${body.code}`)))) {
      await client.query('UPDATE email_verification_codes SET attempts=attempts+1 WHERE id=$1', [entry.id]);
      await client.query('COMMIT'); return res.status(400).json({ error: 'invalid_code' });
    }
    await client.query('UPDATE email_verification_codes SET consumed_at=now() WHERE id=$1', [entry.id]);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    const { rows: users } = await client.query(`SELECT u.id, u.account_status, u.is_guest, u.name, u.password_hash IS NOT NULL AS has_password,
      ARRAY(SELECT role FROM user_roles r WHERE r.user_id=u.id) AS roles FROM users u WHERE u.email=$1 FOR UPDATE`, [address]);
    let user = users[0];
    if (user && (user.account_status !== 'active' || user.is_guest)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'account_unavailable' }); }
    // An email code is not a password: it may only reopen a passwordless Independent Organizer account.
    if (user && (user.has_password || user.roles.some((role: string) => role !== 'organizer'))) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'use_password_sign_in' });
    }
    if (!user) {
      const { rows } = await client.query(`INSERT INTO users(email,role,name) VALUES($1,'organizer',$2) RETURNING id, name`, [address, name]);
      user = rows[0];
    } else if (!user.name && name) {
      await client.query('UPDATE users SET name=$2 WHERE id=$1', [user.id, name]);
    }
    await client.query(`INSERT INTO user_roles(user_id,role) VALUES($1,'organizer') ON CONFLICT DO NOTHING`, [user.id]);
    const { rows: memberships } = await client.query('SELECT 1 FROM organization_members WHERE user_id=$1 LIMIT 1', [user.id]);
    if (!memberships.length) {
      const { rows: orgs } = await client.query(`INSERT INTO organizations(name,description,owner_id,independent) VALUES($1,$2,$3,TRUE) RETURNING id`,
        [`${name ?? user.name ?? address.split('@')[0]} (Independent)`, 'Personal Independent Organizer workspace', user.id]);
      await client.query('INSERT INTO organization_members(organization_id,user_id) VALUES($1,$2)', [orgs[0].id, user.id]);
    }
    await client.query('COMMIT');
    userId = user.id;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const user = await User.findById(userId);
  const tokens = await createTokens(userId);
  return res.json({ user: user && { id: user.id, email: user.email, name: user.name, role: user.role, roles: user.roles,
    isGuest: user.isGuest, tedixUserId: user.tedixUserId, accountStatus: user.accountStatus, createdAt: user.createdAt }, tokens });
});
