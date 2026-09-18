import type { Migration } from './types.js';

export const huntTemplateSelectionMigration: Migration = {
  id: '005_hunt_template_selection',
  async up(client) {
    await client.query(`
      ALTER TABLE hunts
        ADD COLUMN template_key TEXT,
        ADD COLUMN template_version INTEGER CHECK (template_version IS NULL OR template_version >= 1),
        ADD COLUMN template_snapshot JSONB;
    `);
  },
};

export default huntTemplateSelectionMigration;
