import { pool } from '../lib/postgres.js';
import { fail } from '../domain/participantAccess.js';

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
  /** Compatibility entry point for existing identities only.
   * D7 has not approved a provisioning actor or invitation transport. Keep the
   * model fail-closed too: knowing Hunt/user UUIDs is not admission authority.
   * Lifecycle and authenticated access remain enforced by ParticipantAccess.
   */
  async enroll(huntId: string, userId: string): Promise<IHuntParticipant> {
    const participant = await HuntParticipant.findByHuntAndUser(huntId, userId);
    return participant ?? fail(422, 'enrollment_policy_unresolved');
  },

  async findByHuntAndUser(huntId: string, userId: string): Promise<IHuntParticipant | null> {
    const { rows } = await pool.query(
      'SELECT * FROM hunt_participants WHERE hunt_id = $1 AND user_id = $2 LIMIT 1',
      [huntId, userId],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },
};
