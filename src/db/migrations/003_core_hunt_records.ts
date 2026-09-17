import type { Migration } from './types.js';

export const coreHuntRecordsMigration: Migration = {
  id: '003_core_hunt_records',
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS hunts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
        created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('draft', 'published', 'active', 'paused', 'cancelled', 'finished')
        ),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS hunt_participants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (hunt_id, user_id),
        UNIQUE (hunt_id, id)
      );

      CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (hunt_id, name),
        UNIQUE (hunt_id, id)
      );

      -- hunt_id lets composite foreign keys guarantee that both referenced records share one Hunt.
      CREATE TABLE IF NOT EXISTS team_members (
        hunt_id UUID NOT NULL,
        team_id UUID NOT NULL,
        hunt_participant_id UUID NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, hunt_participant_id),
        UNIQUE (hunt_id, hunt_participant_id),
        FOREIGN KEY (hunt_id, team_id) REFERENCES teams(hunt_id, id) ON DELETE CASCADE,
        FOREIGN KEY (hunt_id, hunt_participant_id)
          REFERENCES hunt_participants(hunt_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS hunt_roles (
        hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('organizer', 'supervisor')),
        UNIQUE (hunt_id, user_id, role)
      );
    `);
  },
};

export default coreHuntRecordsMigration;
