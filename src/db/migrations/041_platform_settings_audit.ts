import type { Migration } from './types.js';

/** L5 Platform Settings (true global configuration only) and L6 privileged-action Audit Log.
 * Settings rows exist only once an Admin changes a value; absent keys use the documented defaults.
 * Audit events are append-only: actor identity is snapshotted so retiring a user keeps the history readable.
 */
export const platformSettingsAuditSql = `
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-zA-Z]*\\.[a-z][a-zA-Z]*$'),
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  actor_roles TEXT[] NOT NULL DEFAULT '{}',
  action TEXT NOT NULL CHECK (action ~ '^[a-z_]+\\.[a-z_]+$'),
  category TEXT NOT NULL CHECK (category IN ('users', 'applications', 'templates', 'hunts', 'safety', 'settings', 'requests', 'account')),
  target_type TEXT,
  target_id TEXT,
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_occurred_idx ON audit_events(occurred_at DESC, id DESC);
CREATE INDEX audit_events_category_idx ON audit_events(category, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, occurred_at DESC);
CREATE FUNCTION protect_audit_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  -- Account deletion may only null the actor reference; history itself is immutable.
  IF TG_OP = 'UPDATE' AND ROW(NEW.id, NEW.occurred_at, NEW.actor_label, NEW.actor_roles, NEW.action, NEW.category,
    NEW.target_type, NEW.target_id, NEW.summary, NEW.details) IS NOT DISTINCT FROM ROW(OLD.id, OLD.occurred_at,
    OLD.actor_label, OLD.actor_roles, OLD.action, OLD.category, OLD.target_type, OLD.target_id, OLD.summary, OLD.details)
    AND NEW.actor_user_id IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION protect_audit_events();
`;

const migration: Migration = {
  id: '041_platform_settings_audit',
  async up(client) { await client.query(platformSettingsAuditSql); },
};
export default migration;
