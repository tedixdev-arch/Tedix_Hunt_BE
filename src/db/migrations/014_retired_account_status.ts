import type { Migration } from './types.js';

export const retiredAccountStatusMigration: Migration = {
  id: '014_retired_account_status',
  async up(client) {
    await client.query(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
      ALTER TABLE users ADD CONSTRAINT users_account_status_check
        CHECK (account_status IN ('active', 'blocked', 'retired'));
    `);
  },
};

export default retiredAccountStatusMigration;
