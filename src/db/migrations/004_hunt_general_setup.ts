import type { Migration } from './types.js';

export const huntGeneralSetupMigration: Migration = {
  id: '004_hunt_general_setup',
  async up(client) {
    await client.query(`
      ALTER TABLE hunts
        ADD COLUMN country TEXT,
        ADD COLUMN region TEXT,
        ADD COLUMN city TEXT,
        ADD COLUMN start_date DATE,
        ADD COLUMN start_time TIME,
        ADD COLUMN timezone TEXT,
        ADD COLUMN duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes >= 1),
        ADD COLUMN capacity INTEGER CHECK (capacity IS NULL OR capacity >= 1),
        ADD COLUMN contact_name TEXT;
    `);
  },
};

export default huntGeneralSetupMigration;
