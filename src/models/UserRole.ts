import { pool } from '../lib/postgres.js';

export type UserRole = 'participant' | 'organizer' | 'creator' | 'admin';
export const USER_ROLES: readonly UserRole[] = ['participant', 'organizer', 'creator', 'admin'];
export class LastAdminError extends Error {}

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
    if (role !== 'admin') {
      await pool.query('DELETE FROM user_roles WHERE user_id = $1 AND role = $2', [userId, role]);
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Any future role-removal/deactivation flow must use this helper. The lock serializes
      // final-Admin checks against authoritative roles and account status.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('active-admin-invariant'))");
      const result = await client.query(
        `SELECT count(*)::int AS count FROM user_roles ur JOIN users u ON u.id = ur.user_id
         WHERE ur.role = 'admin' AND u.account_status = 'active'`,
      );
      const target = await client.query(
        `SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
         WHERE ur.user_id = $1 AND ur.role = 'admin'
           AND u.account_status = 'active'`, [userId],
      );
      if (target.rows[0] && result.rows[0].count <= 1) throw new LastAdminError();
      await client.query("DELETE FROM user_roles WHERE user_id = $1 AND role = 'admin'", [userId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};
