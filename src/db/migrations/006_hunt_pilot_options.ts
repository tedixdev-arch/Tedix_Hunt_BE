import type { Migration } from './types.js';

export const huntPilotOptionsMigration: Migration = {
  id: '006_hunt_pilot_options',
  async up(client) {
    await client.query(`
      ALTER TABLE hunts
        ADD COLUMN hunt_format TEXT CHECK (hunt_format IS NULL OR hunt_format IN ('team')),
        ADD COLUMN team_size INTEGER CHECK (team_size IS NULL OR team_size = 4),
        ADD COLUMN access_mode TEXT CHECK (access_mode IS NULL OR access_mode IN ('invitation_only')),
        ADD COLUMN difficulty TEXT CHECK (difficulty IS NULL OR difficulty IN ('easy')),
        ADD COLUMN checkpoint_order TEXT CHECK (checkpoint_order IS NULL OR checkpoint_order IN ('recommended'));
    `);
  },
};

export default huntPilotOptionsMigration;
