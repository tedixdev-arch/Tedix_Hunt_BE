import type { Migration } from './types.js';

export const huntAccessCodeMigration: Migration = {
  id: '007_hunt_access_code',
  async up(client) {
    await client.query(`
      ALTER TABLE hunts
        ADD COLUMN access_code TEXT UNIQUE
          CHECK (access_code IS NULL OR access_code ~ '^[A-HJ-NP-Z2-9]{8}$');
    `);
  },
};

export default huntAccessCodeMigration;
