-- TedixHunt API schema (PostgreSQL)
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

-- users.role is transitional compatibility data; user_roles is authoritative.
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

CREATE TABLE IF NOT EXISTS hunts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'published', 'active', 'paused', 'cancelled', 'finished')
  ),
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
