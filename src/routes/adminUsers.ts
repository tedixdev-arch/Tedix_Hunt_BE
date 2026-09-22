import express from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import {
  ActivationAlreadyPendingError,
  AdminProvisioning,
  GuestPromotionError,
} from '../models/AdminProvisioning.js';
import type { IUser } from '../models/User.js';

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
 *     summary: List Admin identities
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: role
 *         required: true
 *         schema: { type: string, enum: [admin] }
 *     responses:
 *       200:
 *         description: Safe Admin identity list
 *         content:
 *           application/json:
 *             schema: { type: array, items: { $ref: '#/components/schemas/AdminUser' } }
 *       403: { description: Admin capability required }
 */
router.get('/', requireAuth, requireRole('admin'), async (request, response) => {
  if (request.query.role !== 'admin') return response.status(400).json({ error: 'invalid_role' });
  const admins = await AdminProvisioning.list();
  return response.json(admins.map((admin) => ({
    ...safeUser(admin), activationState: admin.activationState,
  })));
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
