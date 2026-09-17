import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { signJwt } from '../lib/jwt.js';
import { User, type IUser } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { Organization } from '../models/Organization.js';
import { environment } from '../config/environment.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';

const router = express.Router();

const publicUser = (user: IUser) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  isGuest: user.isGuest,
  tedixUserId: user.tedixUserId,
  createdAt: user.createdAt,
});

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

const parseDurationToMs = (value: string) => {
  if (value.endsWith('d')) {
    const days = Number(value.slice(0, -1));
    return days * 24 * 60 * 60 * 1000;
  }
  if (value.endsWith('m')) {
    const mins = Number(value.slice(0, -1));
    return mins * 60 * 1000;
  }
  return 0;
};

const createTokens = async (userId: string) => {
  const accessToken = signJwt({ sub: userId });

  const refreshToken = signJwt(
    { sub: userId },
    { expiresIn: environment.refreshTokenExpiresIn as jwt.SignOptions['expiresIn'] },
  );

  const expiresAt = new Date(Date.now() + parseDurationToMs(environment.refreshTokenExpiresIn));

  await RefreshToken.create({ user: userId, token: refreshToken, expiresAt });

  return { accessToken, refreshToken };
};

/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Creator, participant and guest authentication
 */

/**
 * @openapi
 * /api/auth/creator/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a CREATOR account
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
 *               name: { type: string }
 *     responses:
 *       201:
 *         description: Creator account created
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
 *       409:
 *         description: Email already registered
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/creator/register', async (req, res, next) => {
  const { email, password, name } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'invalid_input' });

  const exists = await User.findOne({ email });
  if (exists) return res.status(409).json({ error: 'email_taken' });

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const user = await User.create({ email, passwordHash, role: 'creator', name });
    const tokens = await createTokens(user.id);
    res.status(201).json({ user: publicUser(user), tokens });
  } catch (error) {
    // The database constraint is authoritative when concurrent registrations race.
    if (isUniqueViolation(error)) return res.status(409).json({ error: 'email_taken' });
    next(error);
  }
});

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

    const passwordHash = await bcrypt.hash(password, 10);
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
  const accessToken = signJwt({ sub: user.id }, { expiresIn: '1h' });
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
  if (!refreshToken) return res.status(400).json({ error: 'invalid_input' });

  const stored = await RefreshToken.findOne({ token: refreshToken });
  if (!stored) return res.status(401).json({ error: 'invalid_refresh' });

  if (stored.expiresAt < new Date()) {
    await RefreshToken.deleteOne(stored.id);
    return res.status(401).json({ error: 'refresh_expired' });
  }

  const userId = String(stored.user);
  await RefreshToken.deleteOne(stored.id);

  const tokens = await createTokens(userId);
  res.json(tokens);
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
  const user = req.user;
  const organizations = await Organization.findByOwnerOrMember(user.id);
  res.json({
    ...publicUser(user),
    organizations: organizations.map((org) => org.id),
  });
});

export const authRouter = router;
