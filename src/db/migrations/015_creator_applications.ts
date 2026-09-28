import type { Migration } from './types.js';

export const creatorApplicationsMigration: Migration = {
  id: '015_creator_applications',
  async up(client) {
    await client.query(`
      CREATE TABLE creator_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (
          status IN ('pending', 'approved', 'rejected')
        ),
        reviewed_at TIMESTAMPTZ,
        reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX creator_applications_status_created_at_idx
        ON creator_applications (status, created_at DESC);
      CREATE UNIQUE INDEX creator_applications_pending_user_key
        ON creator_applications (user_id) WHERE status = 'pending';
    `);
  },
};

export default creatorApplicationsMigration;
