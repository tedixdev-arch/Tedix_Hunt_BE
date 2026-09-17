import { pool } from '../lib/postgres.js';
import { HuntRoles } from './HuntRole.js';

export type HuntStatus = 'draft' | 'published' | 'active' | 'paused' | 'cancelled' | 'finished';

export interface IHunt {
  id: string;
  organizationId: string;
  createdByUserId: string;
  name: string;
  status: HuntStatus;
  createdAt: Date;
  updatedAt: Date;
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

const mapRow = (row: any): IHunt => ({
  id: row.id,
  organizationId: row.organization_id,
  createdByUserId: row.created_by_user_id,
  name: row.name,
  status: row.status,
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
    return mapRow(rows[0]);
  },

  async findById(id: string): Promise<IHunt | null> {
    const { rows } = await pool.query('SELECT * FROM hunts WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ? mapRow(rows[0]) : null;
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
      return mapRow(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async updateDraft(id: string, name: string): Promise<IHunt | null> {
    const { rows } = await pool.query(
      `UPDATE hunts SET name = $2, updated_at = now()
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [id, name],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async transitionStatus(input: TransitionHuntInput): Promise<IHunt | null> {
    const { rows } = await pool.query(
      `UPDATE hunts SET status = $2, updated_at = now()
       WHERE id = $1 AND status = ANY($3::text[])
       RETURNING *`,
      [input.id, input.to, input.from],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },
};
