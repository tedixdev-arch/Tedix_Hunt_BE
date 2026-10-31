import { inheritedRadii, type CheckpointRadii } from '../domain/checkpointRadius.js';
import type { PoolClient } from 'pg';
import { validateHuntForPublish } from '../domain/huntReadiness.js';
import { pool } from '../lib/postgres.js';
import { HuntRoles, type HuntRole } from './HuntRole.js';
import { generateHuntAccessCode } from '../domain/huntAccess.js';

export type HuntTemplateSnapshot = Record<string, unknown>;

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string })?.code === '23505';

export type HuntStatus = 'draft' | 'published' | 'active' | 'paused' | 'cancelled' | 'finished';

export interface IHunt {
  id: string;
  organizationId: string;
  createdByUserId: string;
  name: string;
  status: HuntStatus;
  country: string | null;
  region: string | null;
  city: string | null;
  startDate: string | null;
  startTime: string | null;
  timezone: string | null;
  durationMinutes: number | null;
  capacity: number | null;
  contactName: string | null;
  templateId?: string | null;
  templateLocalityId?: string | null;
  templateLocalitySnapshot?: import('./HuntTemplate.js').LocalitySnapshot | null;
  templateKey: string | null;
  templateVersion: number | null;
  templateSnapshot: HuntTemplateSnapshot | null;
  checkpointRadiusConfiguration?: CheckpointRadii | null;
  format: 'team' | null;
  teamSize: number | null;
  accessMode: 'invitation_only' | null;
  difficulty: 'easy' | null;
  checkpointOrder: 'recommended' | null;
  accessCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IHuntListItem extends IHunt {
  huntRoles: HuntRole[];
}

export interface CreateHuntInput {
  organizationId: string;
  createdByUserId: string;
  name: string;
  status?: HuntStatus;
}

export interface TransitionHuntInput {
  id: string;
  from: readonly HuntStatus[];
  to: HuntStatus;
}

export interface UpdateHuntGeneralSetupInput {
  name?: string;
  country?: string;
  region?: string;
  city?: string;
  startDate?: string;
  startTime?: string;
  timezone?: string;
  durationMinutes?: number;
  capacity?: number;
  contactName?: string;
  templateKey?: string;
  templateVersion?: number;
  templateSnapshot?: HuntTemplateSnapshot;
  checkpointRadiusConfiguration?: CheckpointRadii;
  format?: 'team';
  teamSize?: 4;
  accessMode?: 'invitation_only';
  difficulty?: 'easy';
  checkpointOrder?: 'recommended';
}

export const mapHuntRow = (row: any): IHunt => ({
  id: row.id,
  organizationId: row.organization_id,
  createdByUserId: row.created_by_user_id,
  name: row.name,
  status: row.status,
  country: row.country ?? null,
  region: row.region ?? null,
  city: row.city ?? null,
  startDate: row.start_date instanceof Date
    ? `${row.start_date.getFullYear()}-${String(row.start_date.getMonth()+1).padStart(2,'0')}-${String(row.start_date.getDate()).padStart(2,'0')}`
    : row.start_date ?? null,
  startTime: row.start_time ?? null,
  timezone: row.timezone ?? null,
  durationMinutes: row.duration_minutes ?? null,
  capacity: row.capacity ?? null,
  contactName: row.contact_name ?? null,
  templateId: row.template_id ?? null,
  templateLocalityId: row.template_locality_id ?? null,
  templateLocalitySnapshot: row.template_locality_snapshot ?? null,
  templateKey: row.template_key ?? null,
  templateVersion: row.template_version ?? null,
  templateSnapshot: row.template_snapshot ?? null,
  checkpointRadiusConfiguration: row.checkpoint_radius_configuration ?? null,
  format: row.hunt_format ?? null,
  teamSize: row.team_size ?? null,
  accessMode: row.access_mode ?? null,
  difficulty: row.difficulty ?? null,
  checkpointOrder: row.checkpoint_order ?? null,
  accessCode: row.access_code ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const Hunt = {
  async create(input: CreateHuntInput): Promise<IHunt> {
    const { rows } = await pool.query(
      `INSERT INTO hunts (organization_id, created_by_user_id, name, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.organizationId, input.createdByUserId, input.name, input.status ?? 'draft'],
    );
    return mapHuntRow(rows[0]);
  },

  async findById(id: string): Promise<IHunt | null> {
    const { rows } = await pool.query('SELECT * FROM hunts WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ? mapHuntRow(rows[0]) : null;
  },

  async findByAccessCode(code: string): Promise<IHunt | null> {
    const { rows } = await pool.query('SELECT * FROM hunts WHERE access_code = $1 LIMIT 1', [code]);
    return rows[0] ? mapHuntRow(rows[0]) : null;
  },

  async ensureAccessCode(
    id: string,
    generator: () => string = generateHuntAccessCode,
    maxAttempts = 5,
  ): Promise<IHunt | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const code = generator();
      try {
        // The conditional update and unique constraint make concurrent creation and collisions safe.
        const { rows } = await pool.query(
          `UPDATE hunts SET access_code = $2, updated_at = now()
           WHERE id = $1 AND access_code IS NULL
             AND status = ANY($3::text[])
           RETURNING *`,
          [id, code, ['published', 'active', 'paused']],
        );
        if (rows[0]) return mapHuntRow(rows[0]);
        return Hunt.findById(id);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (attempt === maxAttempts - 1) throw new Error('hunt_access_code_generation_failed');
      }
    }
    throw new Error('hunt_access_code_generation_failed');
  },

  async findForUser(userId: string): Promise<IHuntListItem[]> {
    const { rows } = await pool.query(
      `SELECT h.*,
              array_agg(hr.role ORDER BY CASE hr.role WHEN 'organizer' THEN 1 ELSE 2 END) AS hunt_roles
       FROM hunts h
       JOIN hunt_roles hr ON hr.hunt_id = h.id
       WHERE hr.user_id = $1
       GROUP BY h.id
       ORDER BY h.updated_at DESC, h.created_at DESC`,
      [userId],
    );
    return rows.map((row) => ({ ...mapHuntRow(row), huntRoles: row.hunt_roles }));
  },

  async createWithOrganizerRole(input: Omit<CreateHuntInput, 'status'>): Promise<IHunt> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO hunts (organization_id, created_by_user_id, name, status)
         VALUES ($1, $2, $3, 'draft')
         RETURNING *`,
        [input.organizationId, input.createdByUserId, input.name],
      );
      await HuntRoles.assign(rows[0].id, input.createdByUserId, 'organizer', client);
      await client.query('COMMIT');
      return mapHuntRow(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async updateDraft(id: string, input: UpdateHuntGeneralSetupInput, client: Pick<PoolClient, 'query'> = pool): Promise<IHunt | null> {
    const columns: Record<keyof UpdateHuntGeneralSetupInput, string> = {
      name: 'name', country: 'country', region: 'region', city: 'city', startDate: 'start_date',
      startTime: 'start_time', timezone: 'timezone', durationMinutes: 'duration_minutes',
      capacity: 'capacity', contactName: 'contact_name',
      templateKey: 'template_key', templateVersion: 'template_version',
      templateSnapshot: 'template_snapshot', checkpointRadiusConfiguration: 'checkpoint_radius_configuration',
      format: 'hunt_format', teamSize: 'team_size', accessMode: 'access_mode',
      difficulty: 'difficulty', checkpointOrder: 'checkpoint_order',
    };
    if (input.templateSnapshot) input = { ...input, checkpointRadiusConfiguration: inheritedRadii(input.templateSnapshot) };
    const entries = Object.entries(input) as [keyof UpdateHuntGeneralSetupInput, unknown][];
    const assignments = entries.map(([field], index) => `${columns[field]} = $${index + 2}`);
    const { rows } = await client.query(
      `UPDATE hunts SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $1 AND status = 'draft'${input.templateKey ? ' AND template_id IS NULL' : ''}
       RETURNING *`,
      [id, ...entries.map(([, value]) => value)],
    );
    return rows[0] ? mapHuntRow(rows[0]) : null;
  },

  async publishDraft(id: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM hunts WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (!row || row.status !== 'draft') { await client.query('ROLLBACK'); return { hunt: null, issues: null }; }
      const readiness = validateHuntForPublish(mapHuntRow(row));
      if (!readiness.ready) { await client.query('ROLLBACK'); return { hunt: null, issues: readiness.issues }; }
      const result = await client.query("UPDATE hunts SET status='published',updated_at=now() WHERE id=$1 RETURNING *",[id]);
      await client.query('COMMIT');
      return { hunt: mapHuntRow(result.rows[0]), issues: null };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },

  async transitionStatus(input: TransitionHuntInput): Promise<IHunt | null> {
    const { rows } = await pool.query(
      `UPDATE hunts SET status = $2, updated_at = now()
       WHERE id = $1 AND status = ANY($3::text[])
       RETURNING *`,
      [input.id, input.to, input.from],
    );
    return rows[0] ? mapHuntRow(rows[0]) : null;
  },
};
