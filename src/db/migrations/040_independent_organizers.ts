import type { Migration } from './types.js';

/** Independent Organizers verify an email with a one-time code and work in a personal organization.
 * Independent organizations cannot configure rewards. Codes are stored only as SHA-256 hashes.
 */
export const independentOrganizersSql = `
ALTER TABLE organizations ADD COLUMN independent BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE email_verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('independent_organizer')),
  code_hash TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_verification_codes_lookup_idx ON email_verification_codes(email, purpose, created_at DESC);
`;

const migration: Migration = {
  id: '040_independent_organizers',
  async up(client) { await client.query(independentOrganizersSql); },
};
export default migration;
