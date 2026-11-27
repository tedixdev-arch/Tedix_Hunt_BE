import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { enqueueMail } from '../lib/mail.js';

/**
 * Custom Hunt workflow (docs/Custom_Hunt_Workflow.md):
 * new -> in_review -> assigned (Admin picks a Creator) -> in_progress (Creator links a Local template)
 * -> completed (Admin approves that template; it becomes exclusive to the requesting organization).
 * Admin may reject at any point before completion. `closed` is the legacy terminal state.
 */
export type CustomRequestStatus = 'new' | 'in_review' | 'assigned' | 'in_progress' | 'completed' | 'rejected' | 'closed';
/** What the Organizer sees: a deliberately simple progress label. */
export type OrganizerProgress = 'in_work' | 'done' | 'rejected' | 'closed';

export class CustomRequestError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}

const OPEN: readonly CustomRequestStatus[] = ['new', 'in_review', 'assigned', 'in_progress'];
export const organizerProgress = (status: CustomRequestStatus): OrganizerProgress =>
  status === 'completed' ? 'done' : status === 'rejected' ? 'rejected' : status === 'closed' ? 'closed' : 'in_work';

// pg parses DATE as local midnight; use local parts so the calendar day never shifts.
const dateOnly = (value: unknown) => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : value ?? null;

const requestSelect = `SELECT q.*, o.name AS org_name,
  c.name AS creator_name, c.email AS creator_email,
  t.key AS template_key, t.status AS template_status, t.submitted_version AS template_submitted_version,
  t.local_approved_version AS template_approved_version,
  tv.content->>'displayName' AS template_display_name, tv.locality_snapshot AS template_locality
  FROM custom_hunt_requests q
  LEFT JOIN organizations o ON o.id = q.organization_id
  LEFT JOIN users c ON c.id = q.assigned_creator_user_id
  LEFT JOIN hunt_templates t ON t.custom_request_id = q.id
  LEFT JOIN LATERAL (SELECT content, locality_snapshot FROM hunt_template_versions v WHERE v.template_id = t.id
    ORDER BY (v.version = t.local_approved_version) DESC, v.version DESC LIMIT 1) tv ON true`;

const template = (r: Record<string, any>) => r.template_key ? {
  key: r.template_key, status: r.template_status, submittedVersion: r.template_submitted_version,
  approvedVersion: r.template_approved_version, displayName: r.template_display_name ?? null,
  locality: r.template_locality ?? null,
} : null;

const base = (r: Record<string, any>) => ({
  id: r.id, organizationName: r.org_name ?? r.organization_name, organizationId: r.organization_id ?? null,
  city: r.city, preferredDate: dateOnly(r.preferred_date), participantCount: r.participant_count, details: r.details,
  status: r.status as CustomRequestStatus, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at ?? null,
});

export const mapAdminRequest = (r: Record<string, any>) => ({
  ...base(r), contactName: r.contact_name, contactEmail: r.contact_email, adminNote: r.admin_note,
  organizerNote: r.organizer_note ?? null, submittedByUserId: r.submitted_by_user_id,
  assignedCreator: r.assigned_creator_user_id ? { id: r.assigned_creator_user_id, name: r.creator_name, email: r.creator_email } : null,
  assignedAt: r.assigned_at ?? null, template: template(r),
});

/** Creators get the brief, never the Organizer's contact details or internal notes. */
const mapCreatorRequest = (r: Record<string, any>) => ({ ...base(r), assignedAt: r.assigned_at ?? null, template: template(r) });

const mapOrganizerRequest = (r: Record<string, any>) => ({
  ...base(r), progress: organizerProgress(r.status), note: r.organizer_note ?? null,
  hunt: r.status === 'completed' ? template(r) : null,
});

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const appUrl = () => (process.env.WEB_ORIGIN?.split(',')[0]?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
const greeting = (name: string) => `Hello ${name || 'there'},`;
const signature = '\n\nThe TedixHunt team';

export const CustomHuntRequests = {
  async submit(input: {
    userId: string | null; organizationId: string | null; contactName: string; contactEmail: string;
    organizationName: string | null; city: string | null; preferredDate: string | null; participantCount: number | null; details: string;
  }) {
    const userId = input.userId && (await pool.query('SELECT 1 FROM users WHERE id=$1', [input.userId])).rowCount ? input.userId : null;
    let organizationId: string | null = null;
    if (userId) {
      const orgs = (await pool.query<{ organization_id: string }>('SELECT organization_id FROM organization_members WHERE user_id=$1', [userId])).rows
        .map(row => row.organization_id);
      if (input.organizationId) {
        if (!orgs.includes(input.organizationId)) throw new CustomRequestError('organization_forbidden', 403);
        organizationId = input.organizationId;
      } else if (orgs.length === 1) organizationId = orgs[0];
    } else if (input.organizationId) throw new CustomRequestError('organization_forbidden', 403);
    const { rows } = await pool.query(`INSERT INTO custom_hunt_requests(submitted_by_user_id,organization_id,contact_name,contact_email,
        organization_name,city,preferred_date,participant_count,details)
      VALUES ($1,$2,$3,$4,COALESCE($5,(SELECT name FROM organizations WHERE id=$2)),$6,$7,$8,$9) RETURNING id, status, created_at`,
      [userId, organizationId, input.contactName, input.contactEmail, input.organizationName, input.city,
        input.preferredDate, input.participantCount, input.details]);
    return { id: rows[0].id, status: rows[0].status, createdAt: rows[0].created_at };
  },

  async listAdmin() {
    const { rows } = await pool.query(`${requestSelect}
      ORDER BY (q.status IN ('completed','rejected','closed')), q.created_at DESC LIMIT 500`);
    return rows.map(mapAdminRequest);
  },

  async getAdmin(id: string, db: Pick<PoolClient, 'query'> = pool) {
    const { rows } = await db.query(`${requestSelect} WHERE q.id=$1`, [id]);
    return rows[0] ? mapAdminRequest(rows[0]) : null;
  },

  /** Status (open states only), internal note and the note shown to the Organizer. */
  async update(id: string, change: { status?: 'new' | 'in_review' | 'closed'; adminNote?: string | null; organizerNote?: string | null }) {
    return transaction(async client => {
      const current = (await client.query('SELECT status FROM custom_hunt_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) throw new CustomRequestError('not_found', 404);
      if (change.status !== undefined && change.status !== current.status) {
        if (!OPEN.includes(current.status)) throw new CustomRequestError('request_finalized');
        if (change.status !== 'closed' && ['assigned', 'in_progress'].includes(current.status))
          throw new CustomRequestError('request_assigned');
      }
      if (change.status === 'closed') await client.query(`UPDATE hunt_templates SET custom_request_id=NULL, updated_at=now()
        WHERE custom_request_id=$1 AND local_approved_version IS NULL`, [id]);
      await client.query(`UPDATE custom_hunt_requests SET status=COALESCE($2,status),
          admin_note=CASE WHEN $3 THEN $4 ELSE admin_note END,
          organizer_note=CASE WHEN $5 THEN $6 ELSE organizer_note END, updated_at=now() WHERE id=$1`,
        [id, change.status ?? null, change.adminNote !== undefined, change.adminNote ?? null,
          change.organizerNote !== undefined, change.organizerNote ?? null]);
      return (await this.getAdmin(id, client))!;
    });
  },

  async assign(id: string, creatorUserId: string) {
    const result = await transaction(async client => {
      const request = (await client.query('SELECT * FROM custom_hunt_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!request) throw new CustomRequestError('not_found', 404);
      if (!OPEN.includes(request.status)) throw new CustomRequestError('request_finalized');
      // Exclusivity needs an owner: a request without an organization cannot produce an exclusive Hunt.
      if (!request.organization_id) throw new CustomRequestError('organization_required');
      const creator = (await client.query(`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role='creator'
        WHERE u.id=$1 AND u.account_status='active' AND NOT u.is_guest FOR SHARE OF u`, [creatorUserId])).rows[0];
      if (!creator) throw new CustomRequestError('creator_not_found', 404);
      const linked = (await client.query('SELECT created_by_user_id FROM hunt_templates WHERE custom_request_id=$1', [id])).rows[0];
      if (linked && linked.created_by_user_id !== creatorUserId) throw new CustomRequestError('template_in_progress');
      const firstAssignment = request.status === 'new' || request.status === 'in_review';
      await client.query(`UPDATE custom_hunt_requests SET assigned_creator_user_id=$2, assigned_at=now(),
          status=CASE WHEN $3 THEN 'in_progress' ELSE 'assigned' END, updated_at=now() WHERE id=$1`, [id, creatorUserId, !!linked]);
      if (firstAssignment) await enqueueMail(client, {
        kind: 'custom_request.in_work', to: request.contact_email,
        subject: 'Your custom Hunt request is in work',
        text: `${greeting(request.contact_name)}\n\nGood news: we accepted your custom Hunt request${request.city ? ` for ${request.city}` : ''} and a Tedix Creator is now building it.\nYou can follow its status under "My custom Hunt requests": ${appUrl()}/#/organizer/custom-requests${signature}`,
      });
      return (await this.getAdmin(id, client))!;
    });
    return result;
  },

  async reject(id: string, organizerNote: string) {
    return transaction(async client => {
      const request = (await client.query('SELECT * FROM custom_hunt_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!request) throw new CustomRequestError('not_found', 404);
      if (!OPEN.includes(request.status)) throw new CustomRequestError('request_finalized');
      // An approved exclusive template must never exist for a rejected request: release the link first.
      await client.query(`UPDATE hunt_templates SET custom_request_id=NULL, updated_at=now()
        WHERE custom_request_id=$1 AND local_approved_version IS NULL`, [id]);
      await client.query(`UPDATE custom_hunt_requests SET status='rejected', organizer_note=$2, updated_at=now() WHERE id=$1`, [id, organizerNote]);
      await enqueueMail(client, {
        kind: 'custom_request.rejected', to: request.contact_email,
        subject: 'Update on your custom Hunt request',
        text: `${greeting(request.contact_name)}\n\nUnfortunately we can't build your custom Hunt request${request.city ? ` for ${request.city}` : ''}.\n\nNote from the Tedix team:\n${organizerNote}\n\nDetails: ${appUrl()}/#/organizer/custom-requests${signature}`,
      });
      return (await this.getAdmin(id, client))!;
    });
  },

  async listForCreator(creatorUserId: string) {
    const { rows } = await pool.query(`${requestSelect} WHERE q.assigned_creator_user_id=$1
      ORDER BY (q.status IN ('completed','rejected','closed')), q.assigned_at DESC NULLS LAST`, [creatorUserId]);
    return rows.map(mapCreatorRequest);
  },

  /** Creator binds one of their own unapproved Local templates to the brief they were assigned. */
  async linkTemplate(id: string, creatorUserId: string, key: string) {
    return transaction(async client => {
      const request = (await client.query('SELECT * FROM custom_hunt_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!request || request.assigned_creator_user_id !== creatorUserId) throw new CustomRequestError('not_found', 404);
      if (request.status !== 'assigned' && request.status !== 'in_progress') throw new CustomRequestError('request_not_assignable');
      const template = (await client.query(`SELECT id, origin, category, created_by_user_id, custom_request_id, local_approved_version, status
        FROM hunt_templates WHERE key=$1 FOR UPDATE`, [key])).rows[0];
      if (!template || template.created_by_user_id !== creatorUserId || template.origin !== 'creator') throw new CustomRequestError('template_not_found', 404);
      if (template.category !== 'local') throw new CustomRequestError('template_not_local');
      if (template.custom_request_id === id) return (await this.getAdmin(id, client))!;
      if (template.custom_request_id) throw new CustomRequestError('template_already_linked');
      if (template.local_approved_version != null || template.status === 'approved') throw new CustomRequestError('template_already_approved');
      if ((await client.query('SELECT 1 FROM hunt_templates WHERE custom_request_id=$1', [id])).rowCount) throw new CustomRequestError('request_already_linked');
      await client.query('UPDATE hunt_templates SET custom_request_id=$2, updated_at=now() WHERE id=$1', [template.id, id]);
      await client.query(`UPDATE custom_hunt_requests SET status='in_progress', updated_at=now() WHERE id=$1`, [id]);
      return (await this.getAdmin(id, client))!;
    });
  },

  async listForOrganizer(userId: string) {
    const { rows } = await pool.query(`${requestSelect} WHERE q.submitted_by_user_id=$1
      OR q.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id=$1)
      ORDER BY q.created_at DESC LIMIT 200`, [userId]);
    return rows.map(mapOrganizerRequest);
  },

  /**
   * Called inside the template approval transaction. Completes the linked request and queues the
   * Organizer email in the same commit, so an approved custom template always has its notification.
   */
  async completeForApprovedTemplate(client: PoolClient, templateId: string) {
    const { rows } = await client.query(`UPDATE custom_hunt_requests q SET status='completed', completed_at=now(), updated_at=now()
      FROM hunt_templates t WHERE t.id=$1 AND q.id=t.custom_request_id AND q.status IN ('assigned','in_progress')
      RETURNING q.contact_email, q.contact_name, q.city`, [templateId]);
    const request = rows[0];
    if (!request) return;
    const name = (await client.query(`SELECT v.content->>'displayName' AS name FROM hunt_templates t
      JOIN hunt_template_versions v ON v.template_id=t.id AND v.version=t.local_approved_version WHERE t.id=$1`, [templateId])).rows[0]?.name;
    await enqueueMail(client, {
      kind: 'custom_request.completed', to: request.contact_email,
      subject: 'Your custom Hunt is ready',
      text: `${greeting(request.contact_name)}\n\nYour custom Hunt${name ? ` "${name}"` : ''} has been approved and is now available only to your organization.\n\nTo schedule and publish it, start a new Hunt, choose ${request.city ? `${request.city} as the location` : 'its city'} and pick it from the list: ${appUrl()}/#/organizer/hunts/new/setup${signature}`,
    });
  },
};
