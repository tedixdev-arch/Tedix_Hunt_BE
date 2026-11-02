import type { Migration } from './types.js';

const migration: Migration = {
  id: '035_hunt_participation_configuration',
  async up(client) {
    // Constraints only: preserve all historical null/Team/four values and snapshots.
    await client.query(`
      ALTER TABLE hunts
        DROP CONSTRAINT hunts_hunt_format_check,
        DROP CONSTRAINT hunts_team_size_check,
        ADD CONSTRAINT hunts_hunt_format_check CHECK (hunt_format IS NULL OR hunt_format IN ('solo', 'team')),
        ADD CONSTRAINT hunts_team_size_check CHECK (team_size IS NULL OR team_size > 0),
        ADD CONSTRAINT hunts_solo_team_size_check CHECK (hunt_format IS DISTINCT FROM 'solo' OR team_size IS NULL);
    `);
  },
};
export default migration;
