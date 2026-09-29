import type { Migration } from './types.js';

export const templateSubmissionMigration: Migration = {
  id: '018_template_submission',
  async up(client) {
    await client.query(`
      ALTER TABLE hunt_templates
        ADD COLUMN submitted_version INTEGER,
        ADD CONSTRAINT hunt_templates_submission_state_check CHECK (
          submitted_version IS NULL OR submitted_version >= 1
        ),
        ADD CONSTRAINT hunt_templates_draft_submission_check CHECK (
          status <> 'draft' OR submitted_version IS NULL
        ),
        ADD CONSTRAINT hunt_templates_submitted_version_check CHECK (
          status <> 'submitted' OR submitted_version IS NOT NULL
        );

      -- The composite reference makes the review artifact an actual immutable version
      -- belonging to this Template, rather than an unverified version number.
      ALTER TABLE hunt_templates
        ADD CONSTRAINT hunt_templates_submitted_version_fkey
        FOREIGN KEY (id, submitted_version)
        REFERENCES hunt_template_versions (template_id, version)
        DEFERRABLE INITIALLY DEFERRED;
    `);
  },
};

export default templateSubmissionMigration;
