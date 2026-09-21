import type { Migration } from './types.js';

export const organizerApprovalMigration: Migration = {
  id: '010_organizer_approval',
  async up(client) {
    await client.query(`
      ALTER TABLE organizer_applications
        ADD COLUMN reviewed_at TIMESTAMPTZ,
        ADD COLUMN reviewed_by UUID REFERENCES users(id),
        ADD COLUMN user_id UUID REFERENCES users(id),
        ADD COLUMN organization_id UUID REFERENCES organizations(id),
        ADD COLUMN activation_token_hash TEXT,
        ADD COLUMN activation_expires_at TIMESTAMPTZ,
        ADD COLUMN activated_at TIMESTAMPTZ;

      CREATE UNIQUE INDEX organizer_applications_activation_token_hash_key
        ON organizer_applications (activation_token_hash)
        WHERE activation_token_hash IS NOT NULL;
    `);
  },
};

export default organizerApprovalMigration;
