import { pool } from '../lib/postgres.js';

export interface IRefreshToken {
  id: string;
  user: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateRefreshTokenInput {
  user: string;
  token: string;
  expiresAt: Date;
}

const mapRow = (row: any): IRefreshToken => ({
  id: row.id,
  user: row.user_id,
  token: row.token,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

export const RefreshToken = {
  async create(input: CreateRefreshTokenInput): Promise<IRefreshToken> {
    const { rows } = await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.user, input.token, input.expiresAt],
    );
    return mapRow(rows[0]);
  },

  async findOne(filter: { token: string }): Promise<IRefreshToken | null> {
    const { rows } = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1 LIMIT 1', [
      filter.token,
    ]);
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async deleteOne(id: string): Promise<void> {
    await pool.query('DELETE FROM refresh_tokens WHERE id = $1', [id]);
  },
};
