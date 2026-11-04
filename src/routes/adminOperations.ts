import express from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { verifyJwt } from '../lib/jwt.js';
import { pool } from '../lib/postgres.js';
import { Gameplay } from '../models/Gameplay.js';
import { TokenBuckets } from '../middleware/abuseProtection.js';
import { settingsView } from '../domain/platformSettings.js';
import { InvalidSettingError, PlatformSettings } from '../models/PlatformSettings.js';
import { Audit } from '../models/Audit.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @openapi
 * /api/admin/dashboard:
 *   get:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Platform metrics and pending work counts
 *     responses: { 200: { description: Dashboard metrics } }
 * /api/admin/hunts:
 *   get:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: All Hunts across organizations with participant counts
 *     parameters: [{ in: query, name: status, schema: { type: string, enum: [draft, published, active, paused, cancelled, finished] } }]
 *     responses: { 200: { description: Hunt list } }
 * /api/admin/alerts:
 *   get:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Participant help and emergency requests across all Hunts
 *     responses: { 200: { description: Alerts, open first } }
 * /api/admin/custom-hunt-requests:
 *   get:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Custom Hunt request queue
 *     responses: { 200: { description: Requests, newest first } }
 * /api/admin/custom-hunt-requests/{id}:
 *   patch:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Update a custom Hunt request status or internal note
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { status: { type: string, enum: [new, in_review, closed] }, adminNote: { type: string, maxLength: 2000, nullable: true } } }
 *     responses: { 200: { description: Updated request }, 404: { description: Unknown request } }
 * /api/admin/settings:
 *   get:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Platform Settings (global configuration) with defaults, current values and last change
 *     responses: { 200: { description: Setting definitions and values } }
 *   put:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Change one or more Platform Settings
 *     description: All changes are validated first and saved together with one audit event that records old and new values.
 *     requestBody:
 *       required: true
 *       content: { application/json: { schema: { type: object, required: [values], properties: { values: { type: object } } } } }
 *     responses: { 200: { description: Updated settings }, 400: { description: Unknown key or invalid value } }
 * /api/admin/audit:
 *   get:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Audit Log of privileged actions, newest first
 *     parameters:
 *       - { in: query, name: category, schema: { type: string, enum: [users, applications, templates, hunts, safety, settings, requests, account] } }
 *       - { in: query, name: actor, schema: { type: string } }
 *       - { in: query, name: q, schema: { type: string } }
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100 } }
 *     responses: { 200: { description: A page of audit events and the next cursor } }
 * /api/custom-hunt-requests:
 *   post:
 *     tags: [Custom Hunt requests]
 *     summary: Ask the Tedix team for a custom Hunt
 *     description: Public. When a valid access token is supplied the request is linked to that account.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contactName, contactEmail, details]
 *             properties:
 *               contactName: { type: string, maxLength: 120 }
 *               contactEmail: { type: string, format: email, maxLength: 254 }
 *               organizationName: { type: string, maxLength: 160 }
 *               city: { type: string, maxLength: 120 }
 *               preferredDate: { type: string, format: date }
 *               participantCount: { type: integer, minimum: 1 }
 *               details: { type: string, maxLength: 4000 }
 *     responses: { 201: { description: Request received }, 400: { description: Invalid input } }
 */
export const adminOperationsRouter = express.Router();
// Guards are per route: this router shares the /api/admin prefix with other Admin routers.
const admin = [requireAuth, requireRole('admin'), ((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }) as express.RequestHandler];

adminOperationsRouter.get('/dashboard', ...admin, async (_req, res) => {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*) FROM users WHERE account_status='active' AND NOT is_guest)::int AS users,
    (SELECT count(*) FROM hunts)::int AS hunts,
    (SELECT count(*) FROM hunts WHERE status IN ('published','active','paused'))::int AS live_hunts,
    (SELECT count(*) FROM hunt_participants)::int AS participants,
    (SELECT count(*) FROM hunt_participants WHERE finished_at IS NOT NULL)::int AS finished_participants,
    (SELECT count(*) FROM hunt_templates WHERE status='submitted')::int AS templates_in_review,
    (SELECT count(*) FROM hunt_templates WHERE status='approved')::int AS approved_templates,
    (SELECT count(*) FROM organizer_applications WHERE status='pending')::int AS organizer_applications,
    (SELECT count(*) FROM creator_applications WHERE status='pending')::int AS creator_applications,
    (SELECT count(*) FROM hunt_help_requests WHERE status='open')::int AS open_alerts,
    (SELECT count(*) FROM custom_hunt_requests WHERE status<>'closed')::int AS open_custom_requests`);
  const m = rows[0];
  res.json({
    users: m.users, hunts: m.hunts, liveHunts: m.live_hunts, participants: m.participants, finishedParticipants: m.finished_participants,
    templatesInReview: m.templates_in_review, approvedTemplates: m.approved_templates,
    pendingOrganizerApplications: m.organizer_applications, pendingCreatorApplications: m.creator_applications,
    openAlerts: m.open_alerts, openCustomRequests: m.open_custom_requests,
  });
});

const huntStatuses = new Set(['draft', 'published', 'active', 'paused', 'cancelled', 'finished']);
adminOperationsRouter.get('/hunts', ...admin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (status !== undefined && !huntStatuses.has(status)) return res.status(400).json({ error: 'invalid_input' });
  const { rows } = await pool.query(`SELECT h.id, h.name, h.status, h.city, h.country, to_char(h.start_date,'YYYY-MM-DD') AS start_date, h.start_time, h.capacity, h.created_at,
      h.template_snapshot->>'displayName' AS template_name, o.id AS organization_id, o.name AS organization_name, o.independent,
      (SELECT count(*) FROM hunt_participants p WHERE p.hunt_id=h.id)::int AS participants,
      (SELECT count(*) FROM hunt_participants p WHERE p.hunt_id=h.id AND p.finished_at IS NOT NULL)::int AS finished,
      (SELECT count(*) FROM hunt_help_requests r WHERE r.hunt_id=h.id AND r.status='open')::int AS open_alerts
    FROM hunts h JOIN organizations o ON o.id=h.organization_id
    WHERE ($1::text IS NULL OR h.status=$1) ORDER BY h.created_at DESC LIMIT 500`, [status ?? null]);
  return res.json({ hunts: rows.map(r => ({ id: r.id, name: r.name, status: r.status, city: r.city, country: r.country,
    startDate: r.start_date, startTime: r.start_time, capacity: r.capacity, createdAt: r.created_at, templateName: r.template_name,
    organization: { id: r.organization_id, name: r.organization_name, independent: r.independent },
    participants: r.participants, finished: r.finished, openAlerts: r.open_alerts })) });
});

adminOperationsRouter.get('/alerts', ...admin, async (_req, res) => {
  res.json({ alerts: await Gameplay.openAlerts() });
});

// pg parses DATE as local midnight; use local parts so the calendar day never shifts.
const dateOnly = (value: unknown) => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : value ?? null;
const mapRequest = (r: Record<string, any>) => ({ id: r.id, contactName: r.contact_name, contactEmail: r.contact_email,
  organizationName: r.organization_name, city: r.city, preferredDate: dateOnly(r.preferred_date), participantCount: r.participant_count,
  details: r.details, status: r.status, adminNote: r.admin_note, submittedByUserId: r.submitted_by_user_id,
  createdAt: r.created_at, updatedAt: r.updated_at });

adminOperationsRouter.get('/custom-hunt-requests', ...admin, async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM custom_hunt_requests ORDER BY (status='closed'), created_at DESC LIMIT 500`);
  res.json({ requests: rows.map(mapRequest) });
});

adminOperationsRouter.patch('/custom-hunt-requests/:id', ...admin, async (req, res) => {
  const body = req.body;
  if (!uuid.test(String(req.params.id)) || !record(body) || !Object.keys(body).length
    || Object.keys(body).some(k => k !== 'status' && k !== 'adminNote')
    || (body.status !== undefined && !['new', 'in_review', 'closed'].includes(body.status as string))
    || (body.adminNote !== undefined && body.adminNote !== null && (typeof body.adminNote !== 'string' || body.adminNote.length > 2000))) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const { rows } = await pool.query(`UPDATE custom_hunt_requests SET
      status=COALESCE($2,status), admin_note=CASE WHEN $3 THEN $4 ELSE admin_note END, updated_at=now()
    WHERE id=$1 RETURNING *`, [req.params.id, body.status ?? null, body.adminNote !== undefined,
    typeof body.adminNote === 'string' ? body.adminNote.trim() || null : null]);
  return rows[0] ? res.json(mapRequest(rows[0])) : res.status(404).json({ error: 'not_found' });
});

adminOperationsRouter.get('/settings', ...admin, (_req, res) => {
  res.json({ settings: settingsView() });
});

adminOperationsRouter.put('/settings', ...admin, async (req: AuthRequest, res) => {
  const values = record(req.body) && Object.keys(req.body).length === 1 ? req.body.values : undefined;
  if (!record(values) || !Object.keys(values).length) return res.status(400).json({ error: 'invalid_input' });
  try {
    const changed = await PlatformSettings.update(values, req.user!);
    return res.json({ changed: changed.map(c => c.key), settings: settingsView() });
  } catch (error) {
    if (error instanceof InvalidSettingError) return res.status(400).json({ error: 'invalid_setting', key: error.key });
    throw error;
  }
});

const auditCategories = new Set(['users', 'applications', 'templates', 'hunts', 'safety', 'settings', 'requests', 'account']);
adminOperationsRouter.get('/audit', ...admin, async (req, res) => {
  const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
  const category = text(req.query.category, 20);
  const limit = Number(req.query.limit ?? 50);
  const cursor = text(req.query.cursor, 100);
  const match = cursor ? /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)_([0-9a-f-]{36})$/i.exec(cursor) : null;
  if ((category && !auditCategories.has(category)) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !match)) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  return res.json(await Audit.list({ category, actor: text(req.query.actor, 120), search: text(req.query.q, 120),
    before: match ? { at: match[1], id: match[2] } : undefined, limit }));
});

const requestBuckets = new TokenBuckets(10000);
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const optionalText = (value: unknown, max: number) => value === undefined || value === null || (typeof value === 'string' && value.trim().length <= max);
export const customHuntRequestsRouter = express.Router();
customHuntRequestsRouter.post('/', async (req: AuthRequest, res) => {
  const retry = requestBuckets.consume(req.ip ?? 'unknown', { capacity: 10, windowMs: 60 * 60 * 1000 });
  if (retry) { res.set('Retry-After', String(retry)); return res.status(429).json({ error: 'rate_limited' }); }
  const b = req.body;
  const allowed = ['contactName', 'contactEmail', 'organizationName', 'city', 'preferredDate', 'participantCount', 'details'];
  if (!record(b) || Object.keys(b).some(k => !allowed.includes(k))
    || typeof b.contactName !== 'string' || !b.contactName.trim() || b.contactName.trim().length > 120
    || typeof b.contactEmail !== 'string' || !email.test(b.contactEmail.trim()) || b.contactEmail.trim().length > 254
    || typeof b.details !== 'string' || !b.details.trim() || b.details.trim().length > 4000
    || !optionalText(b.organizationName, 160) || !optionalText(b.city, 120)
    || (b.preferredDate !== undefined && b.preferredDate !== null && (typeof b.preferredDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.preferredDate) || Number.isNaN(Date.parse(b.preferredDate))))
    || (b.participantCount !== undefined && b.participantCount !== null && (!Number.isInteger(b.participantCount) || (b.participantCount as number) < 1 || (b.participantCount as number) > 100000))) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  let userId: string | null = null;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyJwt<{ sub?: unknown; type?: unknown }>(header.slice(7));
      if (payload.type === 'access' && typeof payload.sub === 'string') userId = payload.sub;
    } catch { /* Anonymous requests are allowed. */ }
  }
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  const { rows } = await pool.query(`INSERT INTO custom_hunt_requests(submitted_by_user_id,contact_name,contact_email,organization_name,city,preferred_date,participant_count,details)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8 RETURNING id, status, created_at`,
    [userId && (await pool.query('SELECT 1 FROM users WHERE id=$1', [userId])).rowCount ? userId : null,
      (b.contactName as string).trim(), (b.contactEmail as string).trim().toLowerCase(), text(b.organizationName), text(b.city),
      b.preferredDate ?? null, b.participantCount ?? null, (b.details as string).trim()]);
  return res.status(201).json({ id: rows[0].id, status: rows[0].status, createdAt: rows[0].created_at });
});
