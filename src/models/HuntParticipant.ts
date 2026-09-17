import { pool } from '../lib/postgres.js';

export interface IHuntParticipant {
  id: string;
  huntId: string;
  userId: string;
  joinedAt: Date;
}

const mapRow = (row: any): IHuntParticipant => ({
  id: row.id,
  huntId: row.hunt_id,
  userId: row.user_id,
  joinedAt: row.joined_at,
});

export const HuntParticipant = {
  async enroll(huntId: string, userId: string): Promise<IHuntParticipant> {
    const { rows } = await pool.query(
      `WITH enrollment AS (
         INSERT INTO hunt_participants (hunt_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (hunt_id, user_id) DO NOTHING
         RETURNING *
       )
       SELECT * FROM enrollment
       UNION ALL
       SELECT * FROM hunt_participants WHERE hunt_id = $1 AND user_id = $2
       LIMIT 1`,
      [huntId, userId],
    );
    return mapRow(rows[0]);
  },

  async findByHuntAndUser(huntId: string, userId: string): Promise<IHuntParticipant | null> {
    const { rows } = await pool.query(
      'SELECT * FROM hunt_participants WHERE hunt_id = $1 AND user_id = $2 LIMIT 1',
      [huntId, userId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },
};
