import type { Migration } from './types.js';

export const userAccountStatusMigration: Migration = {
  id: '013_user_account_status',
  async up(client) {
    // PostgreSQL is authoritative for account access. Existing identities remain usable.
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active'
        CHECK (account_status IN ('active', 'blocked'))
    `);
  },
};

export default userAccountStatusMigration;
