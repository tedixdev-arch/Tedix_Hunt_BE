import express from 'express';
import {
  OrganizerApplications,
  type OrganizationType,
} from '../models/OrganizerApplication.js';

const router = express.Router();
const allowedFields = new Set([
  'name', 'email', 'organizationName', 'organizationType', 'reason', 'phone',
]);
const organizationTypes: OrganizationType[] = ['school', 'ngo', 'community', 'other'];

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

export const organizerApplicationsRouter = router;
