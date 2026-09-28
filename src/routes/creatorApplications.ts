import express from 'express';
import bcrypt from 'bcryptjs';
import {
  CreatorApplications,
  CreatorApplicationIdentityConflictError,
  CreatorApplicationNotPendingError,
  type CreatorApplicationStatus,
} from '../models/CreatorApplication.js';
import { requireAuth, requireAnyRole, type AuthRequest } from '../middleware/auth.js';
import { meetsPasswordPolicy, passwordPolicyError } from '../lib/passwordPolicy.js';

const router = express.Router();
const allowedFields = new Set(['name', 'email', 'password', 'confirmPassword']);
const statuses: CreatorApplicationStatus[] = ['pending', 'approved', 'rejected'];
const PASSWORD_BCRYPT_ROUNDS = 10;

const serialize = (application: Awaited<ReturnType<typeof CreatorApplications.findById>> & {}) => ({
  id: application.id,
  userId: application.userId,
  name: application.name,
  email: application.email,
  status: application.status,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
  reviewedAt: application.reviewedAt,
  reviewedBy: application.reviewedBy,
});

/**
 * @openapi
 * tags:
 *   - name: Creator Applications
 *     description: Self-registration applications, distinct from Admin-provisioned Creator activation
 * /api/creator-applications:
 *   post:
 *     tags: [Creator Applications]
 *     summary: Submit a Creator self-registration application
 *     description: Stores credentials on the shared identity. Creator access remains unauthorized until Admin approval; no activation token is created.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [name, email, password, confirmPassword]
 *             properties:
 *               name: { type: string, minLength: 1 }
 *               email: { type: string, format: email }
 *               password: { type: string, format: password, minLength: 8 }
 *               confirmPassword: { type: string, format: password, minLength: 8 }
 *     responses:
 *       201: { description: Pending Creator application created }
 *       400: { description: Invalid input or password }
 *       409: { description: Identity cannot submit this application }
 *   get:
 *     tags: [Creator Applications]
 *     summary: List Creator applications for Admin review
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, approved, rejected] }
 *     responses:
 *       200: { description: Creator applications }
 *       403: { description: Admin capability required }
 * /api/creator-applications/{id}/approve:
 *   post:
 *     tags: [Creator Applications]
 *     summary: Approve an application and grant Creator capability
 *     description: Authorization only; preserves the original password and creates no activation token.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Application approved }
 *       409: { description: Application already decided or identity unavailable }
 * /api/creator-applications/{id}/reject:
 *   post:
 *     tags: [Creator Applications]
 *     summary: Reject a pending Creator application
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Application rejected }
 *       409: { description: Application already decided }
 */
router.post('/', async (request, response) => {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return response.status(400).json({ error: 'invalid_input' });
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((field) => !allowedFields.has(field)) ||
      typeof input.name !== 'string' || !input.name.trim() ||
      typeof input.email !== 'string' || !input.email.trim() ||
      typeof input.password !== 'string' || !input.password ||
      typeof input.confirmPassword !== 'string') {
    return response.status(400).json({ error: 'invalid_input' });
  }
  if (input.password !== input.confirmPassword) {
    return response.status(400).json({ error: 'password_confirmation_mismatch' });
  }
  if (!meetsPasswordPolicy(input.password)) return response.status(400).json(passwordPolicyError());

  const passwordHash = await bcrypt.hash(input.password, PASSWORD_BCRYPT_ROUNDS);
  try {
    const application = await CreatorApplications.create({
      name: input.name.trim(), email: input.email.trim().toLowerCase(), passwordHash,
    });
    return response.status(201).json({
      id: application.id, name: application.name, email: application.email,
      status: application.status, createdAt: application.createdAt,
    });
  } catch (error) {
    if (error instanceof CreatorApplicationIdentityConflictError) {
      return response.status(409).json({ error: 'creator_application_conflict' });
    }
    throw error;
  }
});

router.get('/', requireAuth, requireAnyRole(['admin']), async (request, response) => {
  const status = request.query.status;
  if (status !== undefined && (typeof status !== 'string' || !statuses.includes(status as CreatorApplicationStatus))) {
    return response.status(400).json({ error: 'invalid_status' });
  }
  const applications = await CreatorApplications.list(status as CreatorApplicationStatus | undefined);
  return response.json(applications.map(serialize));
});

router.post('/:id/approve', requireAuth, requireAnyRole(['admin']), async (request: AuthRequest, response) => {
  if (typeof request.params.id !== 'string') return response.status(400).json({ error: 'invalid_input' });
  try {
    const application = await CreatorApplications.approve(request.params.id, request.user!.id);
    if (!application) return response.status(404).json({ error: 'application_not_found' });
    return response.json({ application: serialize(application) });
  } catch (error) {
    if (error instanceof CreatorApplicationNotPendingError) {
      return response.status(409).json({ error: 'application_already_decided' });
    }
    if (error instanceof CreatorApplicationIdentityConflictError) {
      return response.status(409).json({ error: 'creator_application_conflict' });
    }
    throw error;
  }
});

router.post('/:id/reject', requireAuth, requireAnyRole(['admin']), async (request: AuthRequest, response) => {
  if (typeof request.params.id !== 'string') return response.status(400).json({ error: 'invalid_input' });
  try {
    const application = await CreatorApplications.reject(request.params.id, request.user!.id);
    if (!application) return response.status(404).json({ error: 'application_not_found' });
    return response.json({ application: serialize(application) });
  } catch (error) {
    if (error instanceof CreatorApplicationNotPendingError) {
      return response.status(409).json({ error: 'application_already_decided' });
    }
    throw error;
  }
});

export const creatorApplicationsRouter = router;
