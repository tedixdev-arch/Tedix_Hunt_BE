import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { Audit } from './Audit.js';
import { Hunt, mapHuntRow, type HuntStatus } from './Hunt.js';
import type { IUser } from './User.js';
import { validateHuntForPublish } from '../domain/huntReadiness.js';
import { actionsFrom, lifecycleActions, lifecyclePastTense, type HuntLifecycleAction } from '../domain/huntLifecycle.js';

/** Platform Admin view of every Hunt. Organizer ownership rules are not changed by anything here. */
export class AdminHuntError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly extra: Record<string, unknown> = {}) { super(code); }
}

export const HUNT_STATUSES: readonly HuntStatus[] = ['draft', 'published', 'active', 'paused', 'cancelled', 'finished'];
export const SORTS = { created: 'h.created_at', start: 'h.start_date', name: 'lower(h.name)', status: 'h.status' } as const;
export type AdminHuntSort = keyof typeof SORTS;

export interface AdminHuntFilter {
  q?: string; status?: HuntStatus; organizationId?: string; organizerId?: string; city?: string; country?: string;
  startFrom?: string; startTo?: string; createdFrom?: string; createdTo?: string;
  sort: AdminHuntSort; order: 'asc' | 'desc';
}

const listSelect = `SELECT h.id, h.name, h.status, h.city, h.country, to_char(h.start_date,'YYYY-MM-DD') AS start_date, h.start_time,
    h.timezone, h.duration_minutes, h.capacity, h.created_at, h.updated_at, h.template_snapshot->>'displayName' AS template_name,
    o.id AS organization_id, o.name AS organization_name, o.independent,
    u.id AS organizer_id, u.name AS organizer_name, u.email AS organizer_email,
    COALESCE(p.total,0)::int AS participants, COALESCE(p.active,0)::int AS active_participants, COALESCE(p.finished,0)::int AS finished,
    COALESCE(r.open,0)::int AS open_alerts
  FROM hunts h
  JOIN organizations o ON o.id=h.organization_id
  LEFT JOIN users u ON u.id=h.created_by_user_id
  LEFT JOIN LATERAL (SELECT count(*) total, count(*) FILTER (WHERE started_at IS NOT NULL AND finished_at IS NULL) active,
      count(*) FILTER (WHERE finished_at IS NOT NULL) finished FROM hunt_participants WHERE hunt_id=h.id) p ON true
  LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE status='open') open FROM hunt_help_requests WHERE hunt_id=h.id) r ON true`;

/** Builds the shared WHERE clause; every value is a bound parameter. */
function where(filter: AdminHuntFilter) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (sql: (n: string) => string, value: unknown) => { values.push(value); clauses.push(sql(`$${values.length}`)); };
  if (filter.q) add(n => `(h.name ILIKE ${n} OR o.name ILIKE ${n} OR u.name ILIKE ${n} OR u.email ILIKE ${n} OR h.city ILIKE ${n} OR h.country ILIKE ${n})`,
    `%${filter.q.replace(/[\\%_]/g, c => `\\${c}`)}%`);
  if (filter.status) add(n => `h.status=${n}`, filter.status);
  if (filter.organizationId) add(n => `h.organization_id=${n}::uuid`, filter.organizationId);
  if (filter.organizerId) add(n => `h.created_by_user_id=${n}::uuid`, filter.organizerId);
  if (filter.city) add(n => `h.city ILIKE ${n}`, filter.city);
  if (filter.country) add(n => `h.country ILIKE ${n}`, filter.country);
  if (filter.startFrom) add(n => `h.start_date >= ${n}::date`, filter.startFrom);
  if (filter.startTo) add(n => `h.start_date <= ${n}::date`, filter.startTo);
  if (filter.createdFrom) add(n => `h.created_at >= ${n}::date`, filter.createdFrom);
  // Inclusive calendar day.
  if (filter.createdTo) add(n => `h.created_at < (${n}::date + 1)`, filter.createdTo);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}
const orderBy = (filter: AdminHuntFilter) => {
  const dir = filter.order === 'asc' ? 'ASC' : 'DESC';
  const extra = filter.sort === 'start' ? `, h.start_time ${dir} NULLS LAST` : '';
  return `ORDER BY ${SORTS[filter.sort]} ${dir} NULLS LAST${extra}, h.created_at DESC, h.id`;
};

const mapListRow = (r: Record<string, any>) => ({
  id: r.id, name: r.name, status: r.status as HuntStatus, city: r.city, country: r.country, startDate: r.start_date, startTime: r.start_time,
  timezone: r.timezone, durationMinutes: r.duration_minutes, capacity: r.capacity, createdAt: r.created_at, updatedAt: r.updated_at,
  templateName: r.template_name,
  organization: { id: r.organization_id, name: r.organization_name, independent: r.independent },
  organizer: r.organizer_id ? { id: r.organizer_id, name: r.organizer_name, email: r.organizer_email } : null,
  participants: r.participants, activeParticipants: r.active_participants, finished: r.finished, openAlerts: r.open_alerts,
});
export type AdminHuntRow = ReturnType<typeof mapListRow>;

/** RFC 4180 quoting; formula-leading cells are prefixed so spreadsheets do not evaluate them. */
const csvCell = (value: unknown) => {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export const AdminHunts = {
  async list(filter: AdminHuntFilter, page: number, pageSize: number) {
    const w = where(filter);
    const [{ rows }, count] = await Promise.all([
      pool.query(`${listSelect} ${w.sql} ${orderBy(filter)} LIMIT $${w.values.length + 1} OFFSET $${w.values.length + 2}`,
        [...w.values, pageSize, (page - 1) * pageSize]),
      pool.query(`SELECT count(*)::int AS total FROM hunts h JOIN organizations o ON o.id=h.organization_id
        LEFT JOIN users u ON u.id=h.created_by_user_id ${w.sql}`, w.values),
    ]);
    return { hunts: rows.map(mapListRow), total: count.rows[0].total as number, page, pageSize };
  },

  /** Organizations and organizers that own at least one Hunt, for the filter menus. */
  async filterOptions() {
    const [orgs, organizers] = await Promise.all([
      pool.query(`SELECT DISTINCT o.id, o.name, o.independent FROM hunts h JOIN organizations o ON o.id=h.organization_id ORDER BY o.name LIMIT 1000`),
      pool.query(`SELECT DISTINCT u.id, u.name, u.email FROM hunts h JOIN users u ON u.id=h.created_by_user_id ORDER BY u.email LIMIT 1000`),
    ]);
    return { organizations: orgs.rows, organizers: organizers.rows };
  },

  async exportCsv(filter: AdminHuntFilter, max = 10000) {
    const w = where(filter);
    const { rows } = await pool.query(`${listSelect} ${w.sql} ${orderBy(filter)} LIMIT $${w.values.length + 1}`, [...w.values, max]);
    const header = ['Hunt', 'Organization', 'Independent', 'Organizer name', 'Organizer email', 'City', 'Country', 'Status', 'Created',
      'Start date', 'Start time', 'Timezone', 'Duration (minutes)', 'Capacity', 'Participants', 'Active participants', 'Completed participants', 'Open alerts'];
    const lines = rows.map(mapListRow).map(h => [h.name, h.organization.name, h.organization.independent ? 'yes' : 'no', h.organizer?.name, h.organizer?.email,
      h.city, h.country, h.status, h.createdAt, h.startDate, h.startTime?.slice(0, 5), h.timezone, h.durationMinutes, h.capacity,
      h.participants, h.activeParticipants, h.finished, h.openAlerts].map(csvCell).join(','));
    return { csv: `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`, rows: rows.length, truncated: rows.length === max };
  },

  async detail(id: string) {
    const { rows } = await pool.query(`${listSelect} WHERE h.id=$1`, [id]);
    if (!rows[0]) return null;
    const hunt = await Hunt.findById(id);
    if (!hunt) return null;
    const [help, lifecycle] = await Promise.all([
      pool.query(`SELECT count(*) FILTER (WHERE status='open')::int AS open, count(*) FILTER (WHERE status<>'open')::int AS resolved
        FROM hunt_help_requests WHERE hunt_id=$1`, [id]),
      // Actual start/finish come from the lifecycle audit trail (Organizer actions and Admin overrides).
      pool.query(`SELECT min(occurred_at) FILTER (WHERE details->>'transition' IN ('start')) AS started_at,
          max(occurred_at) FILTER (WHERE details->>'transition' IN ('finish','cancel')) AS ended_at
        FROM audit_events WHERE target_type='hunt' AND target_id=$1 AND action IN ('hunt.lifecycle','hunt.admin_override')`, [id]),
    ]);
    const readiness = hunt.status === 'draft' ? validateHuntForPublish(hunt) : null;
    return {
      ...mapListRow(rows[0]),
      hunt,
      helpRequests: { open: help.rows[0].open as number, resolved: help.rows[0].resolved as number },
      startedAt: lifecycle.rows[0].started_at ?? null,
      endedAt: lifecycle.rows[0].ended_at ?? null,
      allowedActions: actionsFrom(hunt.status),
      readiness,
    };
  },

  async history(id: string) {
    const { rows } = await pool.query(`SELECT id, occurred_at, actor_user_id, actor_label, actor_roles, action, category, summary, details
      FROM audit_events WHERE target_type='hunt' AND target_id=$1 ORDER BY occurred_at DESC, id DESC LIMIT 300`, [id]);
    return rows.map(r => ({ id: r.id, occurredAt: r.occurred_at, actor: { userId: r.actor_user_id, label: r.actor_label, roles: r.actor_roles },
      action: r.action, category: r.category, summary: r.summary, details: r.details }));
  },

  /**
   * Admin lifecycle override. Uses the same transitions and publish readiness as Organizers; the status change and its
   * audit event (actor, previous/new status, reason) commit together.
   */
  async override(id: string, action: HuntLifecycleAction, reason: string, actor: Pick<IUser, 'id' | 'email' | 'name' | 'roles' | 'isGuest'>) {
    const rule = lifecycleActions[action];
    return inTransaction(async client => {
      const current = (await client.query('SELECT * FROM hunts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) throw new AdminHuntError('not_found', 404);
      const previous = current.status as HuntStatus;
      if (!rule.from.includes(previous)) throw new AdminHuntError('invalid_transition', 409, {
        message: `Cannot ${action} a ${previous} Hunt.`, currentStatus: previous, allowedActions: actionsFrom(previous) });
      if (action === 'publish') {
        const readiness = validateHuntForPublish(mapHuntRow(current));
        if (!readiness.ready) throw new AdminHuntError('hunt_not_ready', 422, { issues: readiness.issues });
      }
      const updated = (await client.query('UPDATE hunts SET status=$2, updated_at=now() WHERE id=$1 RETURNING *', [id, rule.to])).rows[0];
      await Audit.record({ actor, action: 'hunt.admin_override', category: 'hunts', targetType: 'hunt', targetId: id,
        summary: `Admin override: Hunt ${lifecyclePastTense[action]}`,
        details: { transition: action, previousStatus: previous, newStatus: rule.to, reason, override: true } }, client);
      return mapHuntRow(updated);
    });
  },
};
