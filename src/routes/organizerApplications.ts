import express from 'express';
import {
  OrganizerApplications,
  ApplicationNotPendingError,
  type OrganizationType,
  type OrganizerApplicationStatus,
} from '../models/OrganizerApplication.js';
import { requireAuth, requireAnyRole, type AuthRequest } from '../middleware/auth.js';

const router = express.Router();
const allowedFields = new Set([
  'name', 'email', 'organizationName', 'organizationType', 'reason', 'phone',
]);
const organizationTypes: OrganizationType[] = ['school', 'ngo', 'community', 'other'];
const statuses: OrganizerApplicationStatus[] = ['pending', 'approved', 'rejected'];

// Deliberately omits the activation token digest from every API representation.
const serialize = (application: Awaited<ReturnType<typeof OrganizerApplications.findById>> & {}) => ({
  id: application.id,
  name: application.name,
  email: application.email,
  organizationName: application.organizationName,
  organizationType: application.organizationType,
  reason: application.reason,
  phone: application.phone,
  status: application.status,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
  reviewedAt: application.reviewedAt,
  reviewedBy: application.reviewedBy,
  userId: application.userId,
  organizationId: application.organizationId,
  activationExpiresAt: application.activationExpiresAt,
  activatedAt: application.activatedAt,
});

/**
 * @openapi
 * tags:
 *   - name: Organizer Applications
 *     description: Public applications for prospective Organizers
 */

/**
 * @openapi
 * /api/organizer-applications:
 *   post:
 *     tags: [Organizer Applications]
 *     summary: Submit an Organizer application
 *     description: Submitting an application does not create an account or grant Organizer access.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             required: [name, email, organizationName, organizationType, reason]
 *             properties:
 *               name: { type: string, minLength: 1 }
 *               email: { type: string, minLength: 1, format: email }
 *               organizationName: { type: string, minLength: 1 }
 *               organizationType: { type: string, enum: [school, ngo, community, other] }
 *               reason: { type: string, minLength: 1 }
 *               phone: { type: string, nullable: true }
 *     responses:
 *       201:
 *         description: Pending application created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/OrganizerApplication' }
 *       400:
 *         description: Invalid input or unsupported request field
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/', async (request, response) => {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return response.status(400).json({ error: 'invalid_input' });
  }

  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    return response.status(400).json({ error: 'invalid_input' });
  }

  const requiredStrings = [input.name, input.email, input.organizationName, input.reason];
  if (requiredStrings.some((value) => typeof value !== 'string' || value.trim() === '') ||
      typeof input.organizationType !== 'string' ||
      !organizationTypes.includes(input.organizationType as OrganizationType) ||
      (input.phone !== undefined && input.phone !== null && typeof input.phone !== 'string')) {
    return response.status(400).json({ error: 'invalid_input' });
  }

  const application = await OrganizerApplications.create({
    name: (input.name as string).trim(),
    email: (input.email as string).trim().toLowerCase(),
    organizationName: (input.organizationName as string).trim(),
    organizationType: input.organizationType as OrganizationType,
    reason: (input.reason as string).trim(),
    phone: typeof input.phone === 'string' ? input.phone.trim() || null : null,
  });

  return response.status(201).json({
    id: application.id,
    name: application.name,
    email: application.email,
    organizationName: application.organizationName,
    organizationType: application.organizationType,
    reason: application.reason,
    phone: application.phone,
    status: application.status,
    createdAt: application.createdAt,
  });
});

router.get('/', requireAuth, requireAnyRole(['admin']), async (request, response) => {
  const status = request.query.status;
  if (status !== undefined && (typeof status !== 'string' || !statuses.includes(status as OrganizerApplicationStatus))) {
    return response.status(400).json({ error: 'invalid_status' });
  }
  const applications = await OrganizerApplications.list(status as OrganizerApplicationStatus | undefined);
  return response.json(applications.map(serialize));
});

router.post('/:id/approve', requireAuth, requireAnyRole(['admin']), async (request: AuthRequest, response) => {
  if (typeof request.params.id !== 'string') return response.status(400).json({ error: 'invalid_input' });
  try {
    const result = await OrganizerApplications.approve(request.params.id, request.user!.id);
    if (!result) return response.status(404).json({ error: 'application_not_found' });
    return response.json({
      application: serialize(result.application),
      activationToken: result.activationToken,
      activationExpiresAt: result.application.activationExpiresAt,
    });
  } catch (error) {
    if (error instanceof ApplicationNotPendingError) {
      return response.status(409).json({ error: 'application_already_decided' });
    }
    throw error;
  }
});

router.post('/:id/reject', requireAuth, requireAnyRole(['admin']), async (request: AuthRequest, response) => {
  if (typeof request.params.id !== 'string') return response.status(400).json({ error: 'invalid_input' });
  try {
    const application = await OrganizerApplications.reject(request.params.id, request.user!.id);
    if (!application) return response.status(404).json({ error: 'application_not_found' });
    return response.json({ application: serialize(application) });
  } catch (error) {
    if (error instanceof ApplicationNotPendingError) {
      return response.status(409).json({ error: 'application_already_decided' });
    }
    throw error;
  }
});

export const organizerApplicationsRouter = router;
