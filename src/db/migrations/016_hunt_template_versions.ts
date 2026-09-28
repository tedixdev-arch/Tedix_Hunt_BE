import type { Migration } from './types.js';

export const huntTemplateVersionsMigration: Migration = {
  id: '016_hunt_template_versions',
  async up(client) {
    await client.query(`
      -- A Template is one concrete reusable implementation built with the Creator framework.
      CREATE TABLE hunt_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL CHECK (origin IN ('platform', 'creator')),
        -- This records provenance, not lifecycle ownership of platform content.
        created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (
          status IN ('draft', 'submitted', 'changes_requested', 'approved')
        ),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (origin = 'platform' OR created_by_user_id IS NOT NULL)
      );

      -- A Template version is an immutable implementation snapshot, not the Creator framework catalog.
      CREATE TABLE hunt_template_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        template_id UUID NOT NULL REFERENCES hunt_templates(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        content JSONB NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('platform', 'creator')),
        -- This records provenance, not lifecycle ownership of platform content.
        created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (template_id, version),
        CHECK (origin = 'platform' OR created_by_user_id IS NOT NULL)
      );
    `);
  },
};

export default huntTemplateVersionsMigration;
