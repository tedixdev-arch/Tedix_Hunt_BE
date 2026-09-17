import { pool } from '../lib/postgres.js';

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
};
