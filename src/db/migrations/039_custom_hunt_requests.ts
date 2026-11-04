import type { Migration } from './types.js';

/** "Ask for a custom Hunt" submissions, reviewed by Admins. Contact details are request data only. */
export const customHuntRequestsSql = `
CREATE TABLE custom_hunt_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_name TEXT NOT NULL CHECK (length(contact_name) BETWEEN 1 AND 120),
  contact_email TEXT NOT NULL CHECK (length(contact_email) BETWEEN 3 AND 254),
  organization_name TEXT CHECK (organization_name IS NULL OR length(organization_name) <= 160),
  city TEXT CHECK (city IS NULL OR length(city) <= 120),
  preferred_date DATE,
  participant_count INTEGER CHECK (participant_count IS NULL OR participant_count BETWEEN 1 AND 100000),
  details TEXT NOT NULL CHECK (length(details) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'closed')),
  admin_note TEXT CHECK (admin_note IS NULL OR length(admin_note) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX custom_hunt_requests_status_idx ON custom_hunt_requests(status, created_at DESC);
`;

const migration: Migration = {
  id: '039_custom_hunt_requests',
  async up(client) { await client.query(customHuntRequestsSql); },
};
export default migration;
