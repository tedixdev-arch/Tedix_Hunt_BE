import type { Migration } from './types.js';

const migration: Migration = {
  id: '027_local_template_approval',
  async up(client) {
    await client.query(`
-- Additive: historical authority is captured only by a locked replacement operation.
ALTER TABLE hunt_templates
  ADD COLUMN local_approved_version INTEGER,
  ADD COLUMN local_suspended_at TIMESTAMPTZ,
  ADD COLUMN local_suspended_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN local_suspension_reason TEXT,
  ADD COLUMN local_suspended_version INTEGER,
  ADD CONSTRAINT hunt_templates_local_category_check CHECK (
    (local_approved_version IS NULL AND local_suspended_at IS NULL) OR
    (category IS NOT NULL AND category = 'local' AND origin = 'creator')
  ),
  ADD CONSTRAINT hunt_templates_local_suspension_check CHECK (
    (local_suspended_at IS NULL AND local_suspended_by_user_id IS NULL
      AND local_suspension_reason IS NULL AND local_suspended_version IS NULL) OR
    (local_suspended_at IS NOT NULL AND local_suspended_by_user_id IS NOT NULL
      AND local_suspension_reason IS NOT NULL AND local_suspended_version IS NOT NULL
      AND length(local_suspension_reason) BETWEEN 1 AND 1000
      AND btrim(local_suspension_reason) <> '')
  ),
  ADD CONSTRAINT hunt_templates_local_approved_version_fkey
    FOREIGN KEY (id, local_approved_version)
    REFERENCES hunt_template_versions(template_id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT hunt_templates_local_suspended_version_fkey
    FOREIGN KEY (id, local_suspended_version)
    REFERENCES hunt_template_versions(template_id, version) ON DELETE RESTRICT;

CREATE FUNCTION protect_local_template_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.local_approved_version IS NOT NULL OR OLD.local_suspended_at IS NOT NULL
      OR (OLD.category='local' AND OLD.status='approved') THEN
      RAISE EXCEPTION 'Retained Local authority cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.local_approved_version IS NOT NULL OR NEW.local_suspended_at IS NOT NULL
      OR (NEW.category='local' AND NEW.status='approved') THEN
      RAISE EXCEPTION 'Local authority requires an existing candidate' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.local_approved_version IS NOT NULL AND
     (NEW.local_approved_version IS NULL OR NEW.local_approved_version < OLD.local_approved_version) THEN
    RAISE EXCEPTION 'Local approval cannot be cleared or regressed' USING ERRCODE = '23514';
  END IF;
  IF OLD.local_suspended_at IS NOT NULL AND
    ROW(NEW.local_suspended_at,NEW.local_suspended_by_user_id,NEW.local_suspension_reason,NEW.local_suspended_version)
      IS DISTINCT FROM
    ROW(OLD.local_suspended_at,OLD.local_suspended_by_user_id,OLD.local_suspension_reason,OLD.local_suspended_version) THEN
    RAISE EXCEPTION 'Local suspension is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.local_suspended_at IS NOT NULL AND OLD.local_suspended_at IS NULL THEN
    authority := COALESCE(OLD.local_approved_version,
      CASE WHEN OLD.status = 'approved' THEN OLD.submitted_version END);
    IF authority IS NULL OR NEW.local_suspended_version IS DISTINCT FROM authority
      OR NEW.local_suspended_at IS DISTINCT FROM transaction_timestamp()
      OR NOT EXISTS (SELECT 1 FROM hunt_template_versions WHERE template_id=OLD.id AND version=authority)
      OR NOT EXISTS (SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id
        WHERE u.id=NEW.local_suspended_by_user_id AND ur.role='admin'
          AND u.account_status='active' AND NOT u.is_guest) THEN
      RAISE EXCEPTION 'Suspension requires exact authority and active Admin' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.local_approved_version IS DISTINCT FROM OLD.local_approved_version THEN
    IF NOT (
      (OLD.status='submitted' AND NEW.status='approved'
        AND OLD.submitted_version=NEW.local_approved_version
        AND NEW.submitted_version=OLD.submitted_version
        AND NOT EXISTS (SELECT 1 FROM hunt_template_reviews r
          WHERE r.template_id=OLD.id AND r.version=NEW.local_approved_version))
      OR
      (OLD.local_approved_version IS NULL AND OLD.status='approved'
        AND OLD.submitted_version=NEW.local_approved_version
        AND NEW.status=OLD.status AND NEW.submitted_version=OLD.submitted_version
        AND EXISTS (SELECT 1 FROM hunt_template_reviews r
          WHERE r.template_id=OLD.id AND r.version=OLD.submitted_version
            AND r.decision='approved' AND r.reviewer_user_id<>OLD.created_by_user_id))
    ) THEN
      RAISE EXCEPTION 'Local pointer requires exact approval or pre-existing compatibility capture' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.category='local' AND NEW.status='approved'
    AND (NEW.local_approved_version IS NOT NULL OR OLD.status<>'approved')
    AND NEW.local_approved_version IS DISTINCT FROM NEW.submitted_version THEN
    RAISE EXCEPTION 'New Local approval must establish exact authority' USING ERRCODE = '23514';
  END IF;
  -- Evidence-less historical pins must survive every authoring operation.
  IF OLD.category='local' AND OLD.status='approved' AND OLD.local_approved_version IS NULL
    AND NEW.local_approved_version IS NULL
    AND ROW(NEW.status,NEW.submitted_version) IS DISTINCT FROM ROW(OLD.status,OLD.submitted_version) THEN
    RAISE EXCEPTION 'Historical Local authority requires evidence before revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hunt_templates_local_authority_protection
  BEFORE INSERT OR UPDATE OR DELETE ON hunt_templates
  FOR EACH ROW EXECUTE FUNCTION protect_local_template_authority();

-- Approved Local evidence can only be inserted for an approval already in progress.
-- The identity guard requires NO prior decision before a normal promotion. Together,
-- these rules make historical evidence pre-existing without inspecting xmin/txids:
-- historical NULL-pointer approvals cannot acquire new approved reviews, and a new
-- approval cannot first insert a review and subsequently relabel it as compatibility.
CREATE FUNCTION bind_local_approval_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_row hunt_templates%ROWTYPE;
BEGIN
  IF NEW.decision<>'approved' THEN RETURN NEW; END IF;
  SELECT * INTO identity_row FROM hunt_templates WHERE id=NEW.template_id AND category='local' FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF (identity_row.status<>'approved'
      OR identity_row.local_approved_version IS DISTINCT FROM NEW.version
      OR identity_row.submitted_version IS DISTINCT FROM NEW.version) THEN
    RAISE EXCEPTION 'Local approved evidence requires an exact approval in progress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hunt_template_reviews_local_approval_binding
  BEFORE INSERT ON hunt_template_reviews
  FOR EACH ROW EXECUTE FUNCTION bind_local_approval_review();

CREATE FUNCTION enforce_local_template_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_identity hunt_templates%ROWTYPE;
BEGIN
  -- A queued event's NEW is an intermediate row. Always reload the final identity,
  -- including on pointer-unchanged events; compatibility never bypasses this check.
  SELECT * INTO final_identity FROM hunt_templates WHERE id=NEW.id;
  IF NOT FOUND OR final_identity.category IS DISTINCT FROM 'local' THEN RETURN NULL; END IF;
  IF final_identity.local_approved_version IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM hunt_template_reviews r
      WHERE r.template_id=final_identity.id AND r.version=final_identity.local_approved_version
        AND r.decision='approved' AND r.reviewer_user_id<>final_identity.created_by_user_id)
      OR (final_identity.status='approved'
        AND final_identity.submitted_version IS DISTINCT FROM final_identity.local_approved_version) THEN
      RAISE EXCEPTION 'Final Local authority requires exact independent approval and a coherent candidate' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Only a NEW approval needs a currently active Admin and the exact approved
  -- candidate at commit. Retained/historical evidence survives reviewer retirement
  -- and candidate drafting, submission or request-changes as before.
  IF TG_OP='UPDATE' AND NEW.local_approved_version IS DISTINCT FROM OLD.local_approved_version
    AND OLD.status='submitted' THEN
    IF final_identity.local_approved_version IS DISTINCT FROM NEW.local_approved_version
      OR final_identity.status<>'approved'
      OR final_identity.submitted_version IS DISTINCT FROM NEW.local_approved_version
      OR NOT EXISTS (SELECT 1 FROM hunt_template_reviews r
        JOIN users u ON u.id=r.reviewer_user_id JOIN user_roles ur ON ur.user_id=u.id
        WHERE r.template_id=final_identity.id AND r.version=NEW.local_approved_version
          AND r.decision='approved' AND r.reviewer_user_id<>final_identity.created_by_user_id
          AND ur.role='admin' AND u.account_status='active' AND NOT u.is_guest) THEN
      RAISE EXCEPTION 'New Local approval requires final exact candidate and active independent Admin evidence' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER hunt_templates_local_approval_evidence
  AFTER INSERT OR UPDATE ON hunt_templates DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_local_template_approval();
    `);
  },
};

export default migration;
