import express from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import {
  ActivationAlreadyPendingError,
  AdminProvisioning,
  GuestPromotionError,
} from '../models/AdminProvisioning.js';
import type { IUser } from '../models/User.js';
import {
  ProfessionalActivationAlreadyPendingError,
  ProfessionalGuestPromotionError,
  ProfessionalProvisioning,
  type ProfessionalRole,
} from '../models/ProfessionalProvisioning.js';

const router = express.Router();

const safeUser = (user: IUser) => ({
  id: user.id, email: user.email, name: user.name, roles: user.roles,
  isGuest: user.isGuest, createdAt: user.createdAt,
});

/**
 * @openapi
 * /api/admin/users:
 *   get:
 *     tags: [Admin Users]
 *     summary: List identities with a global professional capability
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: role
 *         required: true
 *         schema: { type: string, enum: [admin, organizer, creator] }
 *     responses:
 *       200:
 *         description: Safe Admin identity list
 *         content:
 *           application/json:
 *             schema: { type: array, items: { $ref: '#/components/schemas/AdminUser' } }
 *       403: { description: Admin capability required }
 */
router.get('/', requireAuth, requireRole('admin'), async (request, response) => {
  const role = request.query.role;
  if (role !== 'admin' && role !== 'organizer' && role !== 'creator') {
    return response.status(400).json({ error: 'invalid_role' });
  }
  const users = role === 'admin'
    ? await AdminProvisioning.list()
    : await ProfessionalProvisioning.list(role);
  return response.json(users.map((user) => ({
    ...safeUser(user), activationState: user.activationState,
  })));
});

/**
 * @openapi
 * /api/admin/users/professional:
 *   post:
 *     tags: [Admin Users]
 *     summary: Directly provision an Organizer or Creator
 *     description: Existing passwords and roles are preserved. Organizer provisioning requires and atomically creates an organization. Passwordless identities receive a one-time, 24-hour activation token.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [email, role]
 *             properties:
 *               email: { type: string, format: email }
 *               name: { type: string }
 *               role: { type: string, enum: [organizer, creator] }
 *               organizationName: { type: string, description: Required for Organizer }
 *     responses:
 *       200: { description: Existing password-backed identity provisioned }
 *       201: { description: Passwordless identity provisioned; token returned once }
 *       409: { description: Guest promotion forbidden or activation already pending }
 */
router.post('/professional', requireAuth, requireRole('admin'), async (request: AuthRequest, response) => {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return response.status(400).json({ error: 'invalid_input' });
  }
  const { email, name, role, organizationName, ...extra } = body as Record<string, unknown>;
  const emailValid = typeof email === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const roleValid = role === 'organizer' || role === 'creator';
  const organizationValid = role !== 'organizer'
    || (typeof organizationName === 'string' && Boolean(organizationName.trim()));
  if (Object.keys(extra).length || !emailValid || !roleValid || !organizationValid
      || (name !== undefined && (typeof name !== 'string' || !name.trim()))
      || (organizationName !== undefined && typeof organizationName !== 'string')) {
    return response.status(400).json({ error: 'invalid_input' });
  }
  try {
    const result = await ProfessionalProvisioning.provision({
      email: email as string, name: name as string | undefined,
      role: role as ProfessionalRole, createdBy: request.user!.id,
      organizationName: organizationName as string | undefined,
    });
    return response.status(result.activationRequired ? 201 : 200).json({
      user: safeUser(result.user), role: result.role,
      activationRequired: result.activationRequired,
      ...(result.organization ? { organization: result.organization } : {}),
      ...(result.activationToken ? {
        activationToken: result.activationToken,
        activationExpiresAt: result.activationExpiresAt,
      } : {}),
    });
  } catch (error) {
    if (error instanceof ProfessionalGuestPromotionError) {
      return response.status(409).json({ error: 'guest_promotion_not_allowed' });
    }
    if (error instanceof ProfessionalActivationAlreadyPendingError) {
      return response.status(409).json({ error: error.message });
    }
    throw error;
  }
});

/**
 * @openapi
 * /api/admin/users/admin:
 *   post:
 *     tags: [Admin Users]
 *     summary: Provision an additional Admin
 *     description: Existing credentials and roles are preserved. Passwordless identities receive a one-time activation credential.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *               name: { type: string }
 *     responses:
 *       200:
 *         description: Existing identity provisioned
 *       201:
 *         description: Passwordless identity provisioned; activation token is returned only in this response
 *       409:
 *         description: Guest identity or pending activation cannot be provisioned
 */
router.post('/admin', requireAuth, requireRole('admin'), async (request: AuthRequest, response) => {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return response.status(400).json({ error: 'invalid_input' });
  }
  const { email, name, ...extra } = body as Record<string, unknown>;
  if (Object.keys(extra).length || typeof email !== 'string' || !email.trim()
      || (name !== undefined && (typeof name !== 'string' || !name.trim()))) {
    return response.status(400).json({ error: 'invalid_input' });
  }
  try {
    const result = await AdminProvisioning.provision(
      email, name as string | undefined, request.user!.id,
    );
    return response.status(result.activationRequired ? 201 : 200).json({
      user: safeUser(result.user),
      activationRequired: result.activationRequired,
      ...(result.activationToken ? {
        activationToken: result.activationToken,
        activationExpiresAt: result.activationExpiresAt,
      } : {}),
    });
  } catch (error) {
    if (error instanceof GuestPromotionError) {
      return response.status(409).json({ error: 'guest_promotion_not_allowed' });
    }
    if (error instanceof ActivationAlreadyPendingError) {
      return response.status(409).json({ error: 'admin_activation_already_pending' });
    }
    throw error;
  }
});

export const adminUsersRouter = router;
