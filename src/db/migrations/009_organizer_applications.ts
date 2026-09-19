import type { Migration } from './types.js';

export const organizerApplicationsMigration: Migration = {
  id: '009_organizer_applications',
  async up(client) {
    await client.query(`
      CREATE TABLE organizer_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        organization_name TEXT NOT NULL,
        organization_type TEXT NOT NULL CHECK (
          organization_type IN ('school', 'ngo', 'community', 'other')
        ),
        reason TEXT NOT NULL,
        phone TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (
          status IN ('pending', 'approved', 'rejected')
        ),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  },
};

export default organizerApplicationsMigration;
