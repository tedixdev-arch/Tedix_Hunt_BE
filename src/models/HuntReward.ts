import { pool } from '../lib/postgres.js';
import type { RewardKind, RewardProvider, VirtualRewardCategory } from '../domain/rewards.js';

export interface RewardDetails {
  provider: RewardProvider;
  kind: RewardKind;
  category: VirtualRewardCategory | null;
  name: string | null;
  description: string | null;
  quantity: number;
}

export interface LeaderboardReward extends RewardDetails {
  id: string;
  huntId: string;
  place: number;
}

export interface SpecialAward extends RewardDetails {
  id: string;
  huntId: string;
  definitionKey: string;
}

const mapCommon = (row: any): RewardDetails => ({
  provider: row.provider, kind: row.kind, category: row.category ?? null,
  name: row.name ?? null, description: row.description ?? null, quantity: row.quantity,
});
const mapLeaderboard = (row: any): LeaderboardReward => ({
  id: row.id, huntId: row.hunt_id, place: row.place, ...mapCommon(row),
});
const mapSpecial = (row: any): SpecialAward => ({
  id: row.id, huntId: row.hunt_id, definitionKey: row.definition_key, ...mapCommon(row),
});

const detailsValues = (details: RewardDetails) => [
  details.provider, details.kind, details.category, details.name, details.description, details.quantity,
];

export const HuntReward = {
  async list(huntId: string): Promise<{ leaderboard: LeaderboardReward[]; specialAwards: SpecialAward[] }> {
    const [leaderboard, special] = await Promise.all([
      pool.query('SELECT * FROM hunt_leaderboard_rewards WHERE hunt_id = $1 ORDER BY place', [huntId]),
      pool.query('SELECT * FROM hunt_special_awards WHERE hunt_id = $1 ORDER BY created_at, id', [huntId]),
    ]);
    return { leaderboard: leaderboard.rows.map(mapLeaderboard), specialAwards: special.rows.map(mapSpecial) };
  },

  async findLeaderboard(huntId: string, id: string): Promise<LeaderboardReward | null> {
    const { rows } = await pool.query(
      'SELECT * FROM hunt_leaderboard_rewards WHERE hunt_id = $1 AND id = $2 LIMIT 1', [huntId, id],
    );
    return rows[0] ? mapLeaderboard(rows[0]) : null;
  },

  async findSpecial(huntId: string, id: string): Promise<SpecialAward | null> {
    const { rows } = await pool.query(
      'SELECT * FROM hunt_special_awards WHERE hunt_id = $1 AND id = $2 LIMIT 1', [huntId, id],
    );
    return rows[0] ? mapSpecial(rows[0]) : null;
  },

  async createLeaderboard(huntId: string, place: number, details: RewardDetails): Promise<LeaderboardReward | null> {
    const { rows } = await pool.query(
      `INSERT INTO hunt_leaderboard_rewards
         (hunt_id, place, provider, kind, category, name, description, quantity)
       SELECT id, $2, $3, $4, $5, $6, $7, $8 FROM hunts WHERE id = $1 AND status = 'draft'
       RETURNING *`, [huntId, place, ...detailsValues(details)],
    );
    return rows[0] ? mapLeaderboard(rows[0]) : null;
  },

  async updateLeaderboard(huntId: string, id: string, place: number, details: RewardDetails): Promise<LeaderboardReward | null> {
    const { rows } = await pool.query(
      `UPDATE hunt_leaderboard_rewards r SET
         place = $3, provider = $4, kind = $5, category = $6, name = $7,
         description = $8, quantity = $9, updated_at = now()
       FROM hunts h WHERE r.id = $2 AND r.hunt_id = $1 AND h.id = r.hunt_id AND h.status = 'draft'
       RETURNING r.*`, [huntId, id, place, ...detailsValues(details)],
    );
    return rows[0] ? mapLeaderboard(rows[0]) : null;
  },

  async deleteLeaderboard(huntId: string, id: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM hunt_leaderboard_rewards r USING hunts h
       WHERE r.id = $2 AND r.hunt_id = $1 AND h.id = r.hunt_id AND h.status = 'draft'`, [huntId, id],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async createSpecial(huntId: string, definitionKey: string, details: RewardDetails): Promise<SpecialAward | null> {
    const { rows } = await pool.query(
      `INSERT INTO hunt_special_awards
         (hunt_id, definition_key, provider, kind, category, name, description, quantity)
       SELECT id, $2, $3, $4, $5, $6, $7, $8 FROM hunts WHERE id = $1 AND status = 'draft'
       RETURNING *`, [huntId, definitionKey, ...detailsValues(details)],
    );
    return rows[0] ? mapSpecial(rows[0]) : null;
  },

  async updateSpecial(huntId: string, id: string, definitionKey: string, details: RewardDetails): Promise<SpecialAward | null> {
    const { rows } = await pool.query(
      `UPDATE hunt_special_awards r SET
         definition_key = $3, provider = $4, kind = $5, category = $6, name = $7,
         description = $8, quantity = $9, updated_at = now()
       FROM hunts h WHERE r.id = $2 AND r.hunt_id = $1 AND h.id = r.hunt_id AND h.status = 'draft'
       RETURNING r.*`, [huntId, id, definitionKey, ...detailsValues(details)],
    );
    return rows[0] ? mapSpecial(rows[0]) : null;
  },

  async deleteSpecial(huntId: string, id: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM hunt_special_awards r USING hunts h
       WHERE r.id = $2 AND r.hunt_id = $1 AND h.id = r.hunt_id AND h.status = 'draft'`, [huntId, id],
    );
    return (result.rowCount ?? 0) > 0;
  },
};
