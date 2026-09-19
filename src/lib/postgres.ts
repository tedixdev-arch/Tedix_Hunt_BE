import { Pool } from 'pg';
import { environment } from '../config/environment.js';

export const pool = new Pool({ connectionString: environment.databaseUrl });

// Mirrors src/db/schema.sql — kept inline so it ships with the compiled dist/ output
// without relying on a separate asset-copy step in the build.
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL,
  name TEXT,
  is_guest BOOLEAN NOT NULL DEFAULT FALSE,
  tedix_user_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('participant', 'organizer', 'creator', 'admin')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  owner_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS organizer_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  organization_type TEXT NOT NULL CHECK (
    organization_type IN ('school', 'ngo', 'community', 'other')
  ),
  reason TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'approved', 'rejected')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hunts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'published', 'active', 'paused', 'cancelled', 'finished')
  ),
  country TEXT,
  region TEXT,
  city TEXT,
  start_date DATE,
  start_time TIME,
  timezone TEXT,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes >= 1),
  capacity INTEGER CHECK (capacity IS NULL OR capacity >= 1),
  contact_name TEXT,
  template_key TEXT,
  template_version INTEGER CHECK (template_version IS NULL OR template_version >= 1),
  template_snapshot JSONB,
  hunt_format TEXT CHECK (hunt_format IS NULL OR hunt_format IN ('team')),
  team_size INTEGER CHECK (team_size IS NULL OR team_size = 4),
  access_mode TEXT CHECK (access_mode IS NULL OR access_mode IN ('invitation_only')),
  difficulty TEXT CHECK (difficulty IS NULL OR difficulty IN ('easy')),
  checkpoint_order TEXT CHECK (checkpoint_order IS NULL OR checkpoint_order IN ('recommended')),
  access_code TEXT UNIQUE CHECK (access_code IS NULL OR access_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hunt_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, user_id),
  UNIQUE (hunt_id, id)
);

CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, name),
  UNIQUE (hunt_id, id)
);

-- hunt_id lets composite foreign keys guarantee that both referenced records share one Hunt.
CREATE TABLE IF NOT EXISTS team_members (
  hunt_id UUID NOT NULL,
  team_id UUID NOT NULL,
  hunt_participant_id UUID NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, hunt_participant_id),
  UNIQUE (hunt_id, hunt_participant_id),
  FOREIGN KEY (hunt_id, team_id) REFERENCES teams(hunt_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hunt_id, hunt_participant_id)
    REFERENCES hunt_participants(hunt_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hunt_roles (
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('organizer', 'supervisor')),
  UNIQUE (hunt_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organization_members_user_id ON organization_members(user_id);
`;

export const connectPostgres = async (): Promise<void> => {
  if (!environment.databaseUrl) {
    console.warn('DATABASE_URL not provided — skipping PostgreSQL connection.');
    return;
  }

  await pool.query(SCHEMA_SQL);

  console.log('Connected to PostgreSQL');
};

export const disconnectPostgres = async (): Promise<void> => {
  await pool.end();
};
