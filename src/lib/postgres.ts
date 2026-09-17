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
