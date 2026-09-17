import { pool } from '../lib/postgres.js';

export type HuntRole = 'organizer' | 'supervisor';
export const HUNT_ROLES: readonly HuntRole[] = ['organizer', 'supervisor'];

function assertRole(role: string): asserts role is HuntRole {
  if (!HUNT_ROLES.includes(role as HuntRole)) throw new Error('invalid_hunt_role');
}

export const HuntRoles = {
  async assign(huntId: string, userId: string, role: HuntRole): Promise<boolean> {
    assertRole(role);
    const result = await pool.query(
      `INSERT INTO hunt_roles (hunt_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (hunt_id, user_id, role) DO NOTHING`,
      [huntId, userId, role],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async hasRole(huntId: string, userId: string, role: HuntRole): Promise<boolean> {
    assertRole(role);
    const result = await pool.query(
      'SELECT 1 FROM hunt_roles WHERE hunt_id = $1 AND user_id = $2 AND role = $3 LIMIT 1',
      [huntId, userId, role],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  },
};
