import express from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import {
  ActivationAlreadyPendingError,
  AdminProvisioning,
  GuestPromotionError,
} from '../models/AdminProvisioning.js';
import {
  AdminPasswordChangeNotAllowedError,
  LastActiveAdminError,
  normalizeEmail,
  User,
  UserHasProtectedDependenciesError,
  type IUser,
} from '../models/User.js';
import { LastAdminError, UserRoles, type UserRole } from '../models/UserRole.js';
import {
  ProfessionalActivationAlreadyPendingError,
  ProfessionalGuestPromotionError,
  ProfessionalProvisioning,
  type ProfessionalRole,
} from '../models/ProfessionalProvisioning.js';

const router = express.Router();
const PASSWORD_BCRYPT_ROUNDS = 10;

const safeUser = (user: IUser) => ({
  id: user.id, email: user.email, name: user.name, roles: user.roles,
  isGuest: user.isGuest, accountStatus: user.accountStatus, createdAt: user.createdAt,
});

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';

type ManageableRole = Extract<UserRole, 'admin' | 'organizer' | 'creator'>;
const isManageableRole = (role: string): role is ManageableRole =>
  role === 'admin' || role === 'organizer' || role === 'creator';

const changeStatus = (status: 'active' | 'blocked') =>
  async (request: AuthRequest, response: express.Response) => {
    const targetId = String(request.params.id);
    if (status === 'blocked' && targetId === request.user!.id) {
      return response.status(409).json({ error: 'self_block_not_allowed' });
    }
    try {
      const user = await User.setAccountStatus(targetId, status);
      if (!user) return response.status(404).json({ error: 'user_not_found' });
      return response.json({ user: safeUser(user) });
    } catch (error) {
      if (error instanceof LastActiveAdminError) {
        return response.status(409).json({ error: 'last_active_admin' });
      }
      throw error;
    }
  };

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
 * /api/admin/users/{id}:
 *   patch:
 *     tags: [Admin Users]
 *     summary: Edit an identity's safe profile fields
 *     description: Only name and email may be edited. Credentials, account status, roles, sessions, memberships, and Hunt data are preserved.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             minProperties: 1
 *             properties:
 *               name: { type: string, nullable: true }
 *               email: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Updated safe identity representation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { user: { $ref: '#/components/schemas/AdminUser' } }
 *       400: { description: Empty, unsupported, or invalid update }
 *       403: { description: Admin capability required }
 *       404: { description: Identity not found }
 *       409: { description: Normalized email belongs to another identity }
 */
router.patch('/:id', requireAuth, requireRole('admin'), async (request, response) => {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return response.status(400).json({ error: 'invalid_input' });
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.length || keys.some((key) => key !== 'name' && key !== 'email')) {
    return response.status(400).json({ error: 'invalid_input' });
  }

  const update: { name?: string | null; email?: string } = {};
  if ('name' in record) {
    if (record.name !== null && typeof record.name !== 'string') {
      return response.status(400).json({ error: 'invalid_input' });
    }
    const name = typeof record.name === 'string' ? record.name.trim() : null;
    update.name = name || null;
  }
  if ('email' in record) {
    if (typeof record.email !== 'string') {
      return response.status(400).json({ error: 'invalid_input' });
    }
    const email = normalizeEmail(record.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response.status(400).json({ error: 'invalid_input' });
    }
    update.email = email;
    // Give a clear conflict before writing; the database constraint below still closes races.
    const owner = await User.findOne({ email });
    if (owner && owner.id !== String(request.params.id)) {
      return response.status(409).json({ error: 'email_already_in_use' });
    }
  }

  try {
    const user = await User.updateIdentity(String(request.params.id), update);
    if (!user) return response.status(404).json({ error: 'user_not_found' });
    return response.json({ user: safeUser(user) });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return response.status(409).json({ error: 'email_already_in_use' });
    }
    throw error;
  }
});

/**
 * @openapi
 * /api/admin/users/{id}:
 *   delete:
 *     tags: [Admin Users]
 *     summary: Permanently delete a dependency-free identity
 *     description: Requires authoritative Admin capability. Self-deletion and deletion of the final active Admin are forbidden. The operation atomically removes the identity, global roles, refresh sessions, and its activation credentials only when no protected organization, Hunt, participation, supervision, application, or provisioning records reference it.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Identity and account-only records deleted transactionally }
 *       403: { description: Authoritative Admin capability required }
 *       404: { description: Identity not found }
 *       409: { description: Self-delete, protected dependencies, or final active Admin conflict }
 */
router.delete('/:id', requireAuth, requireRole('admin'), async (request: AuthRequest, response) => {
  const targetId = String(request.params.id);
  if (targetId === request.user!.id) {
    return response.status(409).json({ error: 'self_delete_not_allowed' });
  }
  try {
    if (!await User.deleteControlled(targetId)) {
      return response.status(404).json({ error: 'user_not_found' });
    }
    return response.json({ status: 'deleted' });
  } catch (error) {
    if (error instanceof UserHasProtectedDependenciesError) {
      return response.status(409).json({ error: 'user_has_protected_dependencies' });
    }
    if (error instanceof LastActiveAdminError) {
      return response.status(409).json({ error: 'last_active_admin' });
    }
    throw error;
  }
});

/**
 * @openapi
 * /api/admin/users/{id}/password:
 *   put:
 *     tags: [Admin Users]
 *     summary: Directly replace a non-Admin identity's password
 *     description: Requires authoritative Admin capability. The target must not hold the authoritative Admin role and must not be the caller. The password is bcrypt-hashed, all target refresh sessions are atomically revoked, and blocked status and all other identity and business state are preserved. Admins must use /api/auth/change-password for their own password.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [newPassword, confirmPassword]
 *             properties:
 *               newPassword: { type: string, format: password, minLength: 8 }
 *               confirmPassword: { type: string, format: password, minLength: 8 }
 *     responses:
 *       200: { description: Password replaced and all refresh sessions revoked }
 *       400: { description: Invalid password or confirmation mismatch }
 *       403: { description: Authoritative Admin capability required }
 *       404: { description: Target identity not found }
 *       409: { description: Admin target protected or self-target must use account security }
 */
router.put('/:id/password', requireAuth, requireRole('admin'), async (request: AuthRequest, response) => {
  const targetId = String(request.params.id);
  if (targetId === request.user!.id) {
    return response.status(409).json({ error: 'self_password_change_use_account_security' });
  }
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return response.status(400).json({ error: 'invalid_input' });
  }
  const { newPassword, confirmPassword, ...extra } = body as Record<string, unknown>;
  if (Object.keys(extra).length || typeof newPassword !== 'string' || newPassword.length < 8) {
    return response.status(400).json({ error: 'invalid_input' });
  }
  if (typeof confirmPassword !== 'string' || newPassword !== confirmPassword) {
    return response.status(400).json({ error: 'password_confirmation_mismatch' });
  }

  const passwordHash = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_ROUNDS);
  try {
    const user = await User.replaceNonAdminPasswordAndRevokeSessions(targetId, passwordHash);
    if (!user) return response.status(404).json({ error: 'user_not_found' });
    return response.json({ user: safeUser(user) });
  } catch (error) {
    if (error instanceof AdminPasswordChangeNotAllowedError) {
      return response.status(409).json({ error: 'admin_password_change_not_allowed' });
    }
    throw error;
  }
});

/**
 * @openapi
 * /api/admin/users/{id}/block:
 *   post:
 *     tags: [Admin Users]
 *     summary: Block an identity and revoke all of its refresh sessions
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Identity blocked (also returned when already blocked) }
 *       403: { description: Admin capability required }
 *       404: { description: Identity not found }
 *       409: { description: Self-block or blocking the last active Admin is forbidden }
 * /api/admin/users/{id}/unblock:
 *   post:
 *     tags: [Admin Users]
 *     summary: Unblock an identity without restoring revoked sessions
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Identity active (also returned when already active) }
 *       403: { description: Admin capability required }
 *       404: { description: Identity not found }
 */
router.post('/:id/block', requireAuth, requireRole('admin'), changeStatus('blocked'));
router.post('/:id/unblock', requireAuth, requireRole('admin'), changeStatus('active'));

/**
 * @openapi
 * /api/admin/users/{id}/roles/{role}:
 *   post:
 *     tags: [Admin Users]
 *     summary: Grant one global platform capability
 *     description: Idempotently grants a role in user_roles. Organizer grants do not create organizations or memberships, and grants never establish credentials or create Creator records.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: role, required: true, schema: { type: string, enum: [admin, organizer, creator] } }
 *     responses:
 *       200: { description: Updated safe identity representation }
 *       400: { description: Role is not globally manageable }
 *       403: { description: Admin capability required }
 *       404: { description: Identity not found }
 *       409: { description: Conflict }
 *   delete:
 *     tags: [Admin Users]
 *     summary: Remove one global platform capability
 *     description: Idempotently removes a role from user_roles while preserving all other identity and business data. An Admin cannot remove their own Admin capability, and the final active Admin is protected.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *       - { in: path, name: role, required: true, schema: { type: string, enum: [admin, organizer, creator] } }
 *     responses:
 *       200: { description: Updated safe identity representation }
 *       400: { description: Role is not globally manageable }
 *       403: { description: Admin capability required }
 *       404: { description: Identity not found }
 *       409: { description: Self Admin removal or final active Admin removal is forbidden }
 */
router.post('/:id/roles/:role', requireAuth, requireRole('admin'), async (request: AuthRequest, response) => {
  const targetId = String(request.params.id);
  const role = String(request.params.role);
  if (!isManageableRole(role)) return response.status(400).json({ error: 'invalid_role' });

  // Role ownership is independent of account status, credentials, and domain provisioning.
  if (!await User.findById(targetId)) return response.status(404).json({ error: 'user_not_found' });
  await UserRoles.assignRole(targetId, role);
  const user = await User.findById(targetId);
  return response.json({ user: safeUser(user!) });
});

router.delete('/:id/roles/:role', requireAuth, requireRole('admin'), async (request: AuthRequest, response) => {
  const targetId = String(request.params.id);
  const role = String(request.params.role);
  if (!isManageableRole(role)) return response.status(400).json({ error: 'invalid_role' });
  // Self-removal is a distinct conflict even when other active Admins exist.
  if (role === 'admin' && targetId === request.user!.id) {
    return response.status(409).json({ error: 'self_admin_removal_not_allowed' });
  }
  if (!await User.findById(targetId)) return response.status(404).json({ error: 'user_not_found' });
  try {
    await UserRoles.removeRole(targetId, role);
  } catch (error) {
    if (error instanceof LastAdminError) {
      return response.status(409).json({ error: 'last_active_admin' });
    }
    throw error;
  }
  const user = await User.findById(targetId);
  return response.json({ user: safeUser(user!) });
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
