import { pool } from '../lib/postgres.js';

export type UserRole = 'participant' | 'organizer' | 'creator' | 'admin';
export const USER_ROLES: readonly UserRole[] = ['participant', 'organizer', 'creator', 'admin'];

function assertRole(role: string): asserts role is UserRole {
  if (!USER_ROLES.includes(role as UserRole)) throw new Error('invalid_user_role');
}

export const UserRoles = {
  async getRolesForUser(userId: string): Promise<UserRole[]> {
    const { rows } = await pool.query(
      'SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role',
      [userId],
    );
    return rows.map(({ role }) => role as UserRole);
  },

  async hasRole(userId: string, role: UserRole): Promise<boolean> {
    assertRole(role);
    const result = await pool.query(
      'SELECT 1 FROM user_roles WHERE user_id = $1 AND role = $2 LIMIT 1',
      [userId, role],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  },

  // These mutations are intentionally internal-only. B1 exposes no public role-assignment route.
  async assignRole(userId: string, role: UserRole): Promise<void> {
    assertRole(role);
    await pool.query(
      'INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, role],
    );
  },

  async removeRole(userId: string, role: UserRole): Promise<void> {
    assertRole(role);
    await pool.query('DELETE FROM user_roles WHERE user_id = $1 AND role = $2', [userId, role]);
  },
};
