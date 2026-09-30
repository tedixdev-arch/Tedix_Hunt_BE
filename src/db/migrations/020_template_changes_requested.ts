import type { Migration } from './types.js';

export const templateChangesRequestedMigration: Migration = {
  id: '020_template_changes_requested',
  async up(client) {
    await client.query(`
      -- A requested revision still points at the exact immutable artifact Admin reviewed.
      ALTER TABLE hunt_templates
        ADD CONSTRAINT hunt_templates_creator_changes_requested_version_check CHECK (
          origin <> 'creator' OR status <> 'changes_requested' OR submitted_version IS NOT NULL
        );
    `);
  },
};

export default templateChangesRequestedMigration;
