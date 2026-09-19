import type { Migration } from './types.js';

export const huntRewardsMigration: Migration = {
  id: '008_hunt_rewards',
  async up(client) {
    await client.query(`
      CREATE TABLE hunt_leaderboard_rewards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
        place INTEGER NOT NULL CHECK (place BETWEEN 1 AND 50),
        provider TEXT NOT NULL CHECK (provider IN ('organizer', 'tedix_inventory')),
        kind TEXT NOT NULL CHECK (kind IN ('physical', 'virtual')),
        category TEXT CHECK (category IS NULL OR category IN (
          'achievement', 'digital_certificate', 'profile_badge',
          'hunt_passport_collectible', 'partner_digital_benefit'
        )),
        name TEXT,
        description TEXT,
        quantity INTEGER NOT NULL CHECK (quantity >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (hunt_id, place),
        CHECK (provider <> 'organizer' OR (name IS NOT NULL AND btrim(name) <> '')),
        CHECK (provider <> 'tedix_inventory' OR kind <> 'virtual' OR category IS NOT NULL),
        CHECK (provider <> 'tedix_inventory' OR kind <> 'physical' OR
               (category IS NULL AND name IS NULL AND description IS NULL))
      );

      CREATE TABLE hunt_special_awards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
        definition_key TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('organizer', 'tedix_inventory')),
        kind TEXT NOT NULL CHECK (kind IN ('physical', 'virtual')),
        category TEXT CHECK (category IS NULL OR category IN (
          'achievement', 'digital_certificate', 'profile_badge',
          'hunt_passport_collectible', 'partner_digital_benefit'
        )),
        name TEXT,
        description TEXT,
        quantity INTEGER NOT NULL CHECK (quantity >= 1),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (hunt_id, definition_key),
        CHECK (provider <> 'organizer' OR (name IS NOT NULL AND btrim(name) <> '')),
        CHECK (provider <> 'tedix_inventory' OR kind <> 'virtual' OR category IS NOT NULL),
        CHECK (provider <> 'tedix_inventory' OR kind <> 'physical' OR
               (category IS NULL AND name IS NULL AND description IS NULL))
      );
    `);
  },
};

export default huntRewardsMigration;
