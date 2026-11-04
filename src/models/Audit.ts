import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import type { IUser } from './User.js';

export type AuditCategory = 'users' | 'applications' | 'templates' | 'hunts' | 'safety' | 'settings' | 'requests' | 'account';
export interface AuditInput {
  actor: Pick<IUser, 'id' | 'email' | 'name' | 'roles' | 'isGuest'> | null;
  action: string; category: AuditCategory; summary: string;
  targetType?: string; targetId?: string; details?: Record<string, unknown>;
}

const label = (actor: AuditInput['actor']) => actor ? (actor.email ?? actor.name ?? (actor.isGuest ? 'Guest' : actor.id)) : 'System';

export const Audit = {
  async record(input: AuditInput, client: Pick<PoolClient, 'query'> = pool) {
    await client.query(`INSERT INTO audit_events(actor_user_id,actor_label,actor_roles,action,category,target_type,target_id,summary,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.actor?.id ?? null, label(input.actor), input.actor?.roles ?? [], input.action,
      input.category, input.targetType ?? null, input.targetId ?? null, input.summary.slice(0, 500), input.details ?? {}]);
  },

  /** Newest first, keyset-paginated by (occurred_at, id). */
  async list(filter: { category?: string; actor?: string; search?: string; before?: { at: string; id: string }; limit: number }) {
    const { rows } = await pool.query(`SELECT * FROM audit_events
      WHERE ($1::text IS NULL OR category=$1)
        AND ($2::text IS NULL OR actor_label ILIKE '%' || $2 || '%')
        AND ($3::text IS NULL OR summary ILIKE '%' || $3 || '%' OR action ILIKE '%' || $3 || '%' OR target_id = $3)
        AND ($4::timestamptz IS NULL OR (occurred_at, id) < ($4::timestamptz, $5::uuid))
      ORDER BY occurred_at DESC, id DESC LIMIT $6`,
      [filter.category ?? null, filter.actor ?? null, filter.search ?? null, filter.before?.at ?? null, filter.before?.id ?? null, filter.limit + 1]);
    const page = rows.slice(0, filter.limit);
    const last = page.at(-1);
    return {
      events: page.map(r => ({ id: r.id, occurredAt: r.occurred_at, actor: { userId: r.actor_user_id, label: r.actor_label, roles: r.actor_roles },
        action: r.action, category: r.category, targetType: r.target_type, targetId: r.target_id, summary: r.summary, details: r.details })),
      nextCursor: rows.length > filter.limit && last ? `${new Date(last.occurred_at).toISOString()}_${last.id}` : null,
    };
  },
};
