import express from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { pool } from '../lib/postgres.js';
import { Gameplay } from '../models/Gameplay.js';
import { settingsView } from '../domain/platformSettings.js';
import { InvalidSettingError, PlatformSettings } from '../models/PlatformSettings.js';
import { Audit } from '../models/Audit.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @openapi
 * /api/admin/dashboard:
 *   get:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Platform metrics and pending work counts
 *     responses: { 200: { description: Dashboard metrics } }
 * /api/admin/alerts:
 *   get:
 *     tags: [Admin operations]
 *     security: [{ bearerAuth: [] }]
 *     summary: Participant help and emergency requests across all Hunts
 *     parameters: [{ in: query, name: huntId, schema: { type: string, format: uuid }, description: Only this Hunt's requests }]
 *     responses: { 200: { description: Alerts, open first } }
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
    (SELECT count(*) FROM custom_hunt_requests WHERE status NOT IN ('completed','rejected','closed'))::int AS open_custom_requests`);
  const m = rows[0];
  res.json({
    users: m.users, hunts: m.hunts, liveHunts: m.live_hunts, participants: m.participants, finishedParticipants: m.finished_participants,
    templatesInReview: m.templates_in_review, approvedTemplates: m.approved_templates,
    pendingOrganizerApplications: m.organizer_applications, pendingCreatorApplications: m.creator_applications,
    openAlerts: m.open_alerts, openCustomRequests: m.open_custom_requests,
  });
});

adminOperationsRouter.get('/alerts', ...admin, async (req, res) => {
  const huntId = req.query.huntId;
  if (Object.keys(req.query).some(k => k !== 'huntId') || (huntId !== undefined
    && (typeof huntId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(huntId)))) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  res.json({ alerts: await Gameplay.openAlerts(typeof huntId === 'string' ? huntId : undefined) });
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
