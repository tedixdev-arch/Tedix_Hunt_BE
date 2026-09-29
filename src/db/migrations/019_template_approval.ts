import type { Migration } from './types.js';

export const templateApprovalMigration: Migration = {
  id: '019_template_approval',
  async up(client) {
    await client.query(`
      -- Creator approval must retain its pinned artifact; platform Templates use their own lifecycle.
      ALTER TABLE hunt_templates
        ADD CONSTRAINT hunt_templates_creator_approved_version_check CHECK (
          origin <> 'creator' OR status <> 'approved' OR submitted_version IS NOT NULL
        );
    `);
  },
};

export default templateApprovalMigration;
