import type { Migration } from './types.js';

export const templateReviewDecisionsMigration: Migration = {
  id: '021_template_review_decisions',
  async up(client) {
    await client.query(`
      -- Do not backfill: historical approvals have no authoritative reviewer evidence.
      CREATE TABLE hunt_template_reviews (
        template_id UUID NOT NULL,
        version INTEGER NOT NULL,
        reviewer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
        decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (template_id, version),
        FOREIGN KEY (template_id, version)
          REFERENCES hunt_template_versions(template_id, version) ON DELETE RESTRICT
      );
      CREATE INDEX hunt_template_reviews_reviewer_idx ON hunt_template_reviews(reviewer_user_id);
    `);
  },
};

export default templateReviewDecisionsMigration;
