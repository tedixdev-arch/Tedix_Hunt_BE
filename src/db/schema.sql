-- TedixHunt API schema (PostgreSQL)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Retired identities use NULL so anonymization cannot collide and releases the original email.
  email TEXT UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL,
  name TEXT,
  is_guest BOOLEAN NOT NULL DEFAULT FALSE,
  tedix_user_id TEXT UNIQUE,
  account_status TEXT NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('active', 'blocked', 'retired')),
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
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id),
  user_id UUID REFERENCES users(id),
  organization_id UUID REFERENCES organizations(id),
  activation_token_hash TEXT,
  activation_expires_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organizer_applications_activation_token_hash_key
  ON organizer_applications (activation_token_hash) WHERE activation_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS creator_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_applications_status_created_at_idx
  ON creator_applications (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS creator_applications_pending_user_key
  ON creator_applications (user_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS professional_activation_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (
    purpose IN ('admin_activation', 'organizer_activation', 'creator_activation')
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS professional_activation_tokens_active_user_purpose_key
  ON professional_activation_tokens (user_id, purpose) WHERE consumed_at IS NULL;

-- The Creator framework is the available construction system; a Template is one concrete reusable implementation.
CREATE TABLE IF NOT EXISTS hunt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK (origin IN ('platform', 'creator')),
  -- Provenance only: a Creator account does not own platform content lifecycle.
  created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'changes_requested', 'approved')),
  submitted_version INTEGER CHECK (submitted_version IS NULL OR submitted_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (origin = 'platform' OR created_by_user_id IS NOT NULL),
  CHECK (status <> 'draft' OR submitted_version IS NULL),
  CHECK (status <> 'submitted' OR submitted_version IS NOT NULL),
  CHECK (origin <> 'creator' OR status <> 'approved' OR submitted_version IS NOT NULL),
  CHECK (origin <> 'creator' OR status <> 'changes_requested' OR submitted_version IS NOT NULL)
);

-- A Template version is an immutable implementation snapshot, not a catalog of framework options.
CREATE TABLE IF NOT EXISTS hunt_template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES hunt_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  content JSONB NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('platform', 'creator')),
  -- Provenance only: a Creator account does not own platform content lifecycle.
  created_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version),
  CHECK (origin = 'platform' OR created_by_user_id IS NOT NULL)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'hunt_templates_submitted_version_fkey'
  ) THEN
    ALTER TABLE hunt_templates ADD CONSTRAINT hunt_templates_submitted_version_fkey
      FOREIGN KEY (id, submitted_version)
      REFERENCES hunt_template_versions (template_id, version)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

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
  -- Immutable Hunt-time snapshot; existing Hunts do not follow later Template versions.
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

CREATE TABLE IF NOT EXISTS hunt_leaderboard_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  place INTEGER NOT NULL CHECK (place BETWEEN 1 AND 50),
  provider TEXT NOT NULL CHECK (provider IN ('organizer', 'tedix_inventory')),
  kind TEXT NOT NULL CHECK (kind IN ('physical', 'virtual')),
  category TEXT CHECK (category IS NULL OR category IN (
    'achievement', 'digital_certificate', 'profile_badge',
    'hunt_passport_collectible', 'partner_digital_benefit'
  )),
  name TEXT,
  description TEXT,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, place),
  CHECK (provider <> 'organizer' OR (name IS NOT NULL AND btrim(name) <> '')),
  CHECK (provider <> 'tedix_inventory' OR kind <> 'virtual' OR category IS NOT NULL),
  CHECK (provider <> 'tedix_inventory' OR kind <> 'physical' OR
         (category IS NULL AND name IS NULL AND description IS NULL))
);

CREATE TABLE IF NOT EXISTS hunt_special_awards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  definition_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('organizer', 'tedix_inventory')),
  kind TEXT NOT NULL CHECK (kind IN ('physical', 'virtual')),
  category TEXT CHECK (category IS NULL OR category IN (
    'achievement', 'digital_certificate', 'profile_badge',
    'hunt_passport_collectible', 'partner_digital_benefit'
  )),
  name TEXT,
  description TEXT,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (hunt_id, definition_key),
  CHECK (provider <> 'organizer' OR (name IS NOT NULL AND btrim(name) <> '')),
  CHECK (provider <> 'tedix_inventory' OR kind <> 'virtual' OR category IS NOT NULL),
  CHECK (provider <> 'tedix_inventory' OR kind <> 'physical' OR
         (category IS NULL AND name IS NULL AND description IS NULL))
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organization_members_user_id ON organization_members(user_id);

-- Minimal independent Admin review history; existing approvals are not backfilled.
CREATE TABLE IF NOT EXISTS hunt_template_reviews (
  template_id UUID NOT NULL,
  version INTEGER NOT NULL,
  reviewer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (template_id, version),
  FOREIGN KEY (template_id, version)
    REFERENCES hunt_template_versions(template_id, version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS hunt_template_reviews_reviewer_idx ON hunt_template_reviews(reviewer_user_id);

-- F7/C1 category and exact provenance foundation; no classified selection activation.
-- Additive only: NULL remains unclassified, including shipped Signal/starters.
ALTER TABLE hunt_templates
  ADD COLUMN category TEXT CHECK (category IN ('universal', 'local')),
  ADD COLUMN source_template_id UUID,
  ADD COLUMN source_version INTEGER,
  ADD COLUMN source_creator_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN source_review_decision TEXT,
  ADD CONSTRAINT hunt_templates_classified_owner_check CHECK (
    category IS NULL OR (origin = 'creator' AND created_by_user_id IS NOT NULL)
  ),
  ADD CONSTRAINT hunt_templates_source_check CHECK (
    (source_template_id IS NULL AND source_version IS NULL AND
     source_creator_user_id IS NULL AND source_review_decision IS NULL)
    OR
    (category IS NOT NULL AND category = 'local' AND
     source_template_id IS NOT NULL AND source_template_id <> id AND
     source_version IS NOT NULL AND source_version >= 1 AND
     source_creator_user_id IS NOT NULL AND source_review_decision IS NOT NULL AND
     source_review_decision = 'approved')
  );
ALTER TABLE hunt_template_versions
  ADD COLUMN category TEXT CHECK (category IN ('universal', 'local'));
ALTER TABLE hunt_template_reviews
  ADD CONSTRAINT hunt_template_reviews_exact_decision_key UNIQUE (template_id, version, decision);
ALTER TABLE hunt_templates
  ADD CONSTRAINT hunt_templates_source_version_fkey
    FOREIGN KEY (source_template_id, source_version)
    REFERENCES hunt_template_versions(template_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT hunt_templates_source_review_fkey
    FOREIGN KEY (source_template_id, source_version, source_review_decision)
    REFERENCES hunt_template_reviews(template_id, version, decision) ON DELETE RESTRICT;
CREATE INDEX hunt_templates_source_idx ON hunt_templates(source_template_id, source_version)
  WHERE source_template_id IS NOT NULL;

CREATE FUNCTION enforce_template_identity_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source hunt_templates%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.category IS DISTINCT FROM OLD.category OR
       ROW(NEW.source_template_id, NEW.source_version, NEW.source_creator_user_id, NEW.source_review_decision)
         IS DISTINCT FROM
       ROW(OLD.source_template_id, OLD.source_version, OLD.source_creator_user_id, OLD.source_review_decision) OR
       (OLD.category IS NOT NULL AND
        ROW(NEW.id, NEW.key, NEW.origin, NEW.created_by_user_id) IS DISTINCT FROM
        ROW(OLD.id, OLD.key, OLD.origin, OLD.created_by_user_id)) THEN
      RAISE EXCEPTION 'Template category, classified ownership and source binding are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.source_template_id IS NOT NULL THEN
    SELECT * INTO source FROM hunt_templates WHERE id = NEW.source_template_id FOR SHARE;
    IF NOT FOUND OR source.category IS DISTINCT FROM 'universal' OR
       source.created_by_user_id IS DISTINCT FROM NEW.source_creator_user_id THEN
      RAISE EXCEPTION 'Local source must bind an exact Universal and its original Creator' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hunt_templates_identity_binding
  BEFORE INSERT OR UPDATE ON hunt_templates
  FOR EACH ROW EXECUTE FUNCTION enforce_template_identity_binding();

CREATE FUNCTION enforce_template_version_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_row hunt_templates%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.category IS NOT NULL OR
       ROW(NEW.category, NEW.template_id) IS DISTINCT FROM ROW(OLD.category, OLD.template_id) THEN
      RAISE EXCEPTION 'Template version classification and classified snapshots are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT * INTO identity_row FROM hunt_templates WHERE id = NEW.template_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Template identity does not exist' USING ERRCODE = '23503';
  END IF;
  IF NEW.category IS DISTINCT FROM identity_row.category OR
     (NEW.category IS NOT NULL AND
      ROW(NEW.origin, NEW.created_by_user_id) IS DISTINCT FROM
      ROW(identity_row.origin, identity_row.created_by_user_id)) THEN
    RAISE EXCEPTION 'Template version must match identity category and classified owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hunt_template_versions_identity_binding
  BEFORE INSERT OR UPDATE ON hunt_template_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_template_version_binding();

-- F7/C5 publication authority.
-- A candidate's lifecycle is independent of the last approved Universal artifact.
ALTER TABLE hunt_templates
  ADD COLUMN published_version INTEGER,
  ADD CONSTRAINT hunt_templates_published_category_check CHECK (
    published_version IS NULL OR (category IS NOT NULL AND category = 'universal' AND origin = 'creator')
  ),
  ADD CONSTRAINT hunt_templates_published_version_fkey
    FOREIGN KEY (id, published_version)
    REFERENCES hunt_template_versions(template_id, version) ON DELETE RESTRICT;

-- Preserve exactly the products visible under C3/C4, without inventing approval evidence.
UPDATE hunt_templates t SET published_version = t.submitted_version
WHERE t.category = 'universal' AND t.origin = 'creator' AND t.status = 'approved'
  AND EXISTS (SELECT 1 FROM hunt_template_reviews r
    WHERE r.template_id = t.id AND r.version = t.submitted_version
      AND r.decision = 'approved' AND r.reviewer_user_id <> t.created_by_user_id);

CREATE FUNCTION enforce_template_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.published_version IS NOT NULL AND NEW.published_version IS NULL THEN
    RAISE EXCEPTION 'Publication cannot be withdrawn by candidate authoring' USING ERRCODE = '23514';
  END IF;
  IF NEW.published_version IS NOT NULL AND
     (TG_OP = 'INSERT' OR NEW.published_version IS DISTINCT FROM OLD.published_version) AND NOT EXISTS (
    SELECT 1 FROM hunt_templates t JOIN hunt_template_reviews r
      ON r.template_id = t.id AND r.version = t.published_version
    WHERE t.id = NEW.id AND t.status = 'approved' AND t.submitted_version = t.published_version
      AND r.decision = 'approved' AND r.reviewer_user_id <> t.created_by_user_id
  ) THEN
    RAISE EXCEPTION 'Publication requires exact independent approval' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
-- Deferred because approval updates the pin and inserts its review in one transaction.
CREATE CONSTRAINT TRIGGER hunt_templates_publication_evidence
  AFTER INSERT OR UPDATE ON hunt_templates DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_template_publication();

CREATE FUNCTION preserve_classified_template_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hunt_templates WHERE id = OLD.template_id AND category IS NOT NULL) THEN
    RAISE EXCEPTION 'Classified review history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hunt_template_reviews_immutable_classified
  BEFORE UPDATE OR DELETE ON hunt_template_reviews
  FOR EACH ROW EXECUTE FUNCTION preserve_classified_template_review();

-- Initial reviewed reference: ISO 3166-1 alpha-2 RO / Romania. No locality import.
CREATE TABLE countries (
  code TEXT PRIMARY KEY CHECK (code IN (
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX',
    'AZ', 'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ',
    'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK',
    'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM',
    'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
    'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS',
    'GT', 'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN',
    'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN',
    'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV',
    'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ',
    'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF', 'NG', 'NI',
    'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM',
    'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC',
    'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV',
    'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR',
    'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
    'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
  )),
  display_name TEXT NOT NULL CHECK ((length(display_name) BETWEEN 1 AND 100 AND btrim(display_name) <> ''))
);
INSERT INTO countries (code, display_name) VALUES ('RO', 'Romania');

CREATE TABLE localities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code TEXT NOT NULL REFERENCES countries(code) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK ((length(name) BETWEEN 1 AND 200 AND btrim(name) <> '')),
  administrative_context TEXT NOT NULL CHECK ((length(administrative_context) BETWEEN 1 AND 200 AND btrim(administrative_context) <> '')),
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  provider TEXT CHECK ((length(provider) BETWEEN 1 AND 100 AND btrim(provider) <> '')),
  provider_id TEXT CHECK ((length(provider_id) BETWEEN 1 AND 500 AND btrim(provider_id) <> '')),
  provenance TEXT NOT NULL CHECK ((length(provenance) BETWEEN 1 AND 2000 AND btrim(provenance) <> '')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT localities_provider_pair_check CHECK ((provider IS NULL) = (provider_id IS NULL)),
  CONSTRAINT localities_provider_identity_key UNIQUE (provider, provider_id)
);
CREATE INDEX localities_country_name_idx ON localities (country_code, lower(name), id) WHERE active;
-- Supports country FK checks even when all of its localities are inactive.
CREATE INDEX localities_country_idx ON localities (country_code);


CREATE TABLE locality_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  country_code TEXT NOT NULL REFERENCES countries(code) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  administrative_context TEXT NOT NULL CHECK (length(btrim(administrative_context)) BETWEEN 1 AND 200),
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  explanation TEXT NOT NULL CHECK (length(btrim(explanation)) BETWEEN 20 AND 1000 AND explanation !~* 'mapbox'),
  evidence_reference TEXT NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 20 AND 1000 AND evidence_reference !~* 'mapbox'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  decision_reason TEXT CHECK (length(btrim(decision_reason)) BETWEEN 10 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  locality_id UUID REFERENCES localities(id) ON DELETE RESTRICT,
  CHECK (reviewer_user_id IS NULL OR reviewer_user_id <> creator_user_id),
  CHECK (
    (status = 'pending' AND reviewer_user_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL AND locality_id IS NULL)
    OR (status IN ('approved','rejected') AND reviewer_user_id IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL
      AND decided_at >= created_at AND ((status = 'approved') = (locality_id IS NOT NULL)))
  )
);
CREATE INDEX locality_proposals_creator_idx ON locality_proposals (creator_user_id, created_at, id);
CREATE INDEX locality_proposals_pending_idx ON locality_proposals (created_at, id) WHERE status = 'pending';

-- Submitted facts and terminal decisions are permanent; corrections use a new proposal.
CREATE FUNCTION protect_locality_proposal_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Locality proposal history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending' OR
    (to_jsonb(NEW) - ARRAY['status','reviewer_user_id','decision_reason','decided_at','locality_id'])
      IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','reviewer_user_id','decision_reason','decided_at','locality_id']) THEN
    RAISE EXCEPTION 'Locality proposal history is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER locality_proposals_history BEFORE UPDATE OR DELETE ON locality_proposals
  FOR EACH ROW EXECUTE FUNCTION protect_locality_proposal_history();
