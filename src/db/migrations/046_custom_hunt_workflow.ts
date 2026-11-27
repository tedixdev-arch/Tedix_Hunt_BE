import type { Migration } from './types.js';

/**
 * Custom Hunt workflow: Organizer request -> Admin assigns a Creator -> Creator links a Local template ->
 * Admin approves the template -> the template is exclusive to the requesting organization and the
 * Organizer is emailed. The template owns the link (one template per request, one request per template).
 */
export const customHuntWorkflowSql = `
ALTER TABLE custom_hunt_requests
  ADD COLUMN organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN assigned_creator_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN assigned_at TIMESTAMPTZ,
  ADD COLUMN organizer_note TEXT CHECK (organizer_note IS NULL OR length(organizer_note) <= 2000),
  ADD COLUMN completed_at TIMESTAMPTZ;
ALTER TABLE custom_hunt_requests DROP CONSTRAINT custom_hunt_requests_status_check;
ALTER TABLE custom_hunt_requests ADD CONSTRAINT custom_hunt_requests_status_check
  CHECK (status IN ('new', 'in_review', 'assigned', 'in_progress', 'completed', 'rejected', 'closed'));
CREATE INDEX custom_hunt_requests_creator_idx ON custom_hunt_requests(assigned_creator_user_id) WHERE assigned_creator_user_id IS NOT NULL;
CREATE INDEX custom_hunt_requests_organization_idx ON custom_hunt_requests(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX custom_hunt_requests_submitter_idx ON custom_hunt_requests(submitted_by_user_id) WHERE submitted_by_user_id IS NOT NULL;

ALTER TABLE hunt_templates
  ADD COLUMN custom_request_id UUID UNIQUE REFERENCES custom_hunt_requests(id) ON DELETE RESTRICT;

-- Transactional outbox: rows are written with the business change and delivered after commit.
CREATE TABLE email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  to_address TEXT NOT NULL CHECK (length(to_address) BETWEEN 3 AND 254),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'logged', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX email_outbox_pending_idx ON email_outbox(created_at) WHERE status = 'pending';
`;

const migration: Migration = {
  id: '046_custom_hunt_workflow',
  async up(client) { await client.query(customHuntWorkflowSql); },
};
export default migration;
