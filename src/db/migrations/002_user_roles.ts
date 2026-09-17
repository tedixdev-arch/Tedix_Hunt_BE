import type { Migration } from './types.js';

export const userRolesMigration: Migration = {
  id: '002_user_roles',
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('participant', 'organizer', 'creator', 'admin')),
        PRIMARY KEY (user_id, role)
      )
    `);

    // `users.role` remains as a compatibility field, while this table is authoritative.
    // Historical guest rows are participant identities distinguished by users.is_guest.
    await client.query(`
      INSERT INTO user_roles (user_id, role)
      SELECT id,
             CASE WHEN role = 'creator' THEN 'creator' ELSE 'participant' END
        FROM users
       WHERE role IN ('creator', 'participant', 'guest')
      ON CONFLICT DO NOTHING
    `);
  },
};

export default userRolesMigration;
