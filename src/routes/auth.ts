import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { signJwt } from '../lib/jwt.js';
import { normalizeEmail, User, type IUser } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { Organization } from '../models/Organization.js';
import { environment } from '../config/environment.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { OrganizerApplications } from '../models/OrganizerApplication.js';
import { AdminProvisioning } from '../models/AdminProvisioning.js';

const router = express.Router();
const PASSWORD_BCRYPT_ROUNDS = 10;

const publicUser = (user: IUser) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  roles: user.roles,
  isGuest: user.isGuest,
  tedixUserId: user.tedixUserId,
  createdAt: user.createdAt,
});

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

const parseDurationToMs = (value: string): number => {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error('invalid_refresh_token_expiry');
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * multipliers[match[2] as keyof typeof multipliers];
};

export const createTokens = async (userId: string) => {
  const accessToken = signJwt({ sub: userId, type: 'access' });

  // Refresh tokens are opaque, high-entropy credentials; only access tokens are JWTs.
  const refreshToken = crypto.randomBytes(48).toString('base64url');

  const expiresAt = new Date(Date.now() + parseDurationToMs(environment.refreshTokenExpiresIn));

  await RefreshToken.create({ user: userId, token: refreshToken, expiresAt });

  return { accessToken, refreshToken };
};

/** Activates the provisioned organizer account; approval itself never creates a session. */
router.post('/organizer/activate', async (req, res) => {
  const { token, password } = req.body ?? {};
  if (typeof token !== 'string' || !token || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  // Match only the SHA-256 digest; plaintext activation credentials are never persisted.
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const passwordHash = await bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS);
  const user = await OrganizerApplications.activate(tokenHash, passwordHash);
  if (!user) return res.status(401).json({ error: 'invalid_or_expired_activation' });

  const tokens = await createTokens(user.id);
  return res.json({ user: publicUser(user), tokens });
});

/**
 * @openapi
 * /api/auth/admin/activate:
 *   post:
 *     tags: [Auth]
 *     summary: Activate a provisioned Admin identity
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password]
 *             properties:
 *               token: { type: string }
 *               password: { type: string, format: password, minLength: 8 }
 *     responses:
 *       200:
 *         description: Activated and authenticated
 *       401:
 *         description: Invalid, expired, or consumed activation credential
 */
router.post('/admin/activate', async (req, res) => {
  const { token, password } = req.body ?? {};
  if (typeof token !== 'string' || !token || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const passwordHash = await bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS);
  const user = await AdminProvisioning.activate(tokenHash, passwordHash);
  if (!user) return res.status(401).json({ error: 'invalid_or_expired_activation' });
  const tokens = await createTokens(user.id);
  return res.json({ user: publicUser(user), tokens });
});

/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Creator, participant and guest authentication
 */

// Creator capabilities are provisioned only by trusted internal/admin code; there is no public signup.

/**
 * @openapi
 * /api/auth/creator/login:
 *   post:
 *     tags: [Auth]
 *     summary: Creator login
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 tokens: { $ref: '#/components/schemas/AuthTokens' }
 *       400:
 *         description: Missing email or password
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/creator/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'invalid_input' });

  const user = await User.findOne({ email, role: 'creator' });
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash ?? '');
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const tokens = await createTokens(user.id);

  res.json({ user: publicUser(user), tokens });
});

/**
 * @openapi
 * /api/auth/organizer/login:
 *   post:
 *     tags: [Auth]
 *     summary: Organizer login
 *     description: Authenticates users whose authoritative roles include the Organizer capability.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 tokens: { $ref: '#/components/schemas/AuthTokens' }
 *       400:
 *         description: Missing email or password
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/organizer/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'invalid_input' });

  const user = await User.findOne({ email });
  if (!user || !user.roles.includes('organizer')) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash ?? '');
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const tokens = await createTokens(user.id);

  res.json({ user: publicUser(user), tokens });
});

/**
 * @openapi
 * /api/auth/admin/login:
 *   post:
 *     tags: [Auth]
 *     summary: Admin login
 *     description: Authenticates users whose authoritative roles include the Admin capability.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 tokens: { $ref: '#/components/schemas/AuthTokens' }
 *       400:
 *         description: Missing email or password
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/admin/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (
    typeof email !== 'string'
    || !email.trim()
    || typeof password !== 'string'
    || !password
  ) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  const user = await User.findOne({ email: normalizeEmail(email) });
  if (!user || !user.roles.includes('admin')) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash ?? '');
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const tokens = await createTokens(user.id);
  res.json({ user: publicUser(user), tokens });
});

/**
 * @openapi
 * /api/auth/participant/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a participant (TedixHunt or Tedix-linked)
 *     description: >
 *       Accepts either a `tedixUserId` (Tedix-linked identity, no local password),
 *       an `email`/`password` pair (TedixHunt-native credentials), or neither
 *       (a bare participant record for a linked-account flow completed elsewhere).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tedixUserId: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *               name: { type: string }
 *     responses:
 *       201:
 *         description: Participant account created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 tokens: { $ref: '#/components/schemas/AuthTokens' }
 *       409:
 *         description: Email or Tedix account already linked
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/participant/register', async (req, res) => {
  const { email, password, name, tedixUserId } = req.body;

  if (tedixUserId) {
    const exists = await User.findOne({ tedixUserId });
    if (exists) return res.status(409).json({ error: 'tedix_account_linked' });

    try {
      const user = await User.create({ role: 'participant', name, tedixUserId });
      const tokens = await createTokens(user.id);
      return res.status(201).json({ user: publicUser(user), tokens });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return res.status(409).json({ error: 'tedix_account_linked' });
      }
      throw error;
    }
  }

  // participants may register with or without email/password
  if (email && password) {
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: 'email_taken' });

    const passwordHash = await bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS);
    try {
      const user = await User.create({ email, passwordHash, role: 'participant', name });
      const tokens = await createTokens(user.id);
      return res.status(201).json({ user: publicUser(user), tokens });
    } catch (error) {
      if (isUniqueViolation(error)) return res.status(409).json({ error: 'email_taken' });
      throw error;
    }
  }

  // otherwise create a participant without credentials (linked account flow handled elsewhere)
  const user = await User.create({ role: 'participant', name });
  const tokens = await createTokens(user.id);
  return res.status(201).json({ user: publicUser(user), tokens });
});

/**
 * @openapi
 * /api/auth/participant/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login with Tedix or TedixHunt credentials
 *     description: >
 *       Pass `tedixUserId` for Tedix-linked accounts (trusted, no password check),
 *       or `email`/`password` for native TedixHunt participant accounts.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tedixUserId: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 tokens: { $ref: '#/components/schemas/AuthTokens' }
 *       400:
 *         description: Missing email or password (when tedixUserId is absent)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/participant/login', async (req, res) => {
  const { email, password, tedixUserId } = req.body;

  // Tedix-linked accounts authenticate upstream in Tedix; TedixHunt trusts the
  // tedixUserId handed back by that flow rather than holding its own password.
  if (tedixUserId) {
    const user = await User.findOne({ tedixUserId, role: 'participant' });
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });

    const tokens = await createTokens(user.id);
    return res.json({ user: publicUser(user), tokens });
  }

  if (!email || !password) return res.status(400).json({ error: 'invalid_input' });

  const user = await User.findOne({ email, role: 'participant' });
  if (!user) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash ?? '');
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const tokens = await createTokens(user.id);

  res.json({ user: publicUser(user), tokens });
});

/**
 * @openapi
 * /api/auth/guest:
 *   post:
 *     tags: [Auth]
 *     summary: Continue as guest
 *     description: Issues a short-lived (1h) participant access token with no refresh token.
 *     responses:
 *       201:
 *         description: Guest participant token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user: { $ref: '#/components/schemas/User' }
 *                 tokens:
 *                   type: object
 *                   properties:
 *                     accessToken: { type: string }
 */
router.post('/guest', async (_req, res) => {
  const user = await User.create({ role: 'participant', isGuest: true });
  const accessToken = signJwt({ sub: user.id, type: 'access' }, { expiresIn: '1h' });
  res.status(201).json({ user: publicUser(user), tokens: { accessToken } });
});

/**
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh session
 *     description: Rotates the refresh token — the token supplied is consumed and a new pair is issued.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New token pair
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AuthTokens' }
 *       400:
 *         description: Missing refresh token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: Invalid or expired refresh token
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ error: 'invalid_input' });
  }

  // Atomically consume the token so two concurrent requests cannot both rotate it.
  const stored = await RefreshToken.consume(refreshToken);
  if (!stored) return res.status(401).json({ error: 'invalid_refresh' });

  if (stored.expiresAt < new Date()) {
    return res.status(401).json({ error: 'refresh_expired' });
  }

  const userId = String(stored.user);
  const user = await User.findById(userId);
  if (!user || user.isGuest) return res.status(401).json({ error: 'invalid_refresh' });

  const tokens = await createTokens(userId);
  res.json(tokens);
});

/** Invalidates one refresh credential. Logout is idempotent to avoid revealing token state. */
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ error: 'invalid_input' });
  }

  await RefreshToken.deleteByToken(refreshToken);
  return res.status(200).json({ success: true });
});

/** Changes only the authenticated account's password and revokes all of its refresh sessions. */
router.post('/change-password', requireAuth, async (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (
    typeof currentPassword !== 'string'
    || currentPassword.length === 0
    || typeof newPassword !== 'string'
    || newPassword.length < 8
  ) {
    return res.status(400).json({ error: 'invalid_input' });
  }

  const user = req.user!;
  if (user.isGuest || !user.passwordHash) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const matches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!matches) return res.status(401).json({ error: 'invalid_credentials' });

  const passwordHash = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_ROUNDS);
  await User.changePasswordAndRevokeSessions(user.id, passwordHash);
  return res.json({ message: 'Password changed successfully.' });
});

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Current account/profile
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/User' }
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const user = req.user!;
  const organizations = await Organization.findByOwnerOrMember(user.id);
  res.json({
    ...publicUser(user),
    organizations: organizations.map((org) => org.id),
  });
});

export const authRouter = router;
