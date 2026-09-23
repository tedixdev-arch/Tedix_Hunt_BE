import { pool } from '../lib/postgres.js';
import type { HuntStatus } from './Hunt.js';

export interface IHuntContext {
  huntId: string;
  huntName: string;
  huntStatus: HuntStatus;
  participant: boolean;
  supervisor: boolean;
}

const mapRow = (row: any): IHuntContext => ({
  huntId: row.hunt_id,
  huntName: row.hunt_name,
  huntStatus: row.hunt_status,
  participant: row.participant,
  supervisor: row.supervisor,
});

export const HuntContext = {
  async findForUser(userId: string): Promise<IHuntContext[]> {
    const { rows } = await pool.query(
      `WITH user_contexts AS (
         SELECT hunt_id, TRUE AS participant, FALSE AS supervisor
         FROM hunt_participants
         WHERE user_id = $1
         UNION ALL
         SELECT hunt_id, FALSE AS participant, TRUE AS supervisor
         FROM hunt_roles
         WHERE user_id = $1 AND role = 'supervisor'
       ), combined_contexts AS (
         SELECT hunt_id,
                bool_or(participant) AS participant,
                bool_or(supervisor) AS supervisor
         FROM user_contexts
         GROUP BY hunt_id
       )
       SELECT h.id AS hunt_id,
              h.name AS hunt_name,
              h.status AS hunt_status,
              c.participant,
              c.supervisor
       FROM combined_contexts c
       JOIN hunts h ON h.id = c.hunt_id
       ORDER BY CASE h.status
                  WHEN 'active' THEN 1
                  WHEN 'paused' THEN 2
                  WHEN 'published' THEN 3
                  WHEN 'draft' THEN 4
                  WHEN 'finished' THEN 5
                  WHEN 'cancelled' THEN 6
                  ELSE 7
                END,
                h.updated_at DESC,
                h.created_at DESC`,
      [userId],
    );
    return rows.map(mapRow);
  },
};
