import type { Migration } from './types.js';

// No caller-controlled GUC grants transition authority. Only the nested event trigger
// may change status. Actor identity is still supplied by the shared application role.
export const contentReviewSql = `
-- C2a exposes no review API. Do not invent evidence for manually promoted legacy rows.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM library_content_revisions WHERE status<>'draft') THEN
  RAISE EXCEPTION 'Reconcile legacy non-draft Content with verified review provenance before C2c migration';
 END IF;
END $$;
ALTER TABLE library_content_revisions ADD UNIQUE(content_id,id);
CREATE TABLE library_content_review_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 content_id UUID NOT NULL,
 revision_id UUID NOT NULL,
 actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 decision TEXT NOT NULL CHECK(decision IN ('submitted','approved','changes_requested')),
 comment TEXT CHECK(comment IS NULL OR (char_length(comment) BETWEEN 3 AND 1000 AND comment=btrim(comment) AND comment ~ '[[:alnum:]]')),
 decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(content_id,revision_id) REFERENCES library_content_revisions(content_id,id) ON DELETE RESTRICT,
 CHECK(decision<>'changes_requested' OR comment IS NOT NULL),
 CHECK(decision<>'submitted' OR comment IS NULL)
);
CREATE UNIQUE INDEX library_content_one_submission ON library_content_review_events(revision_id) WHERE decision='submitted';
CREATE UNIQUE INDEX library_content_one_decision ON library_content_review_events(revision_id) WHERE decision IN ('approved','changes_requested');
CREATE INDEX library_content_events_history ON library_content_review_events(content_id,decided_at,id);
CREATE INDEX library_content_submitted_queue ON library_content_revisions(id) WHERE status='submitted';

CREATE OR REPLACE FUNCTION protect_library_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' THEN RAISE EXCEPTION 'New revisions must be drafts' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Content revisions cannot be deleted' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN
  RAISE EXCEPTION 'Content revisions are immutable; append a revision' USING ERRCODE='23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND (
  pg_trigger_depth()<>2 OR NOT (
   (OLD.status='draft' AND NEW.status='submitted') OR
   (OLD.status='submitted' AND NEW.status IN ('approved','changes_requested'))
  ) OR NOT EXISTS (SELECT 1 FROM library_content_review_events e
   WHERE e.content_id=NEW.content_id AND e.revision_id=NEW.id AND e.decision=NEW.status)
 ) THEN RAISE EXCEPTION 'Content status requires a guarded review event' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER library_revision_draft_insert BEFORE INSERT ON library_content_revisions FOR EACH ROW EXECUTE FUNCTION protect_library_revision();

CREATE FUNCTION guard_library_review_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c library_content%ROWTYPE; r library_content_revisions%ROWTYPE;
BEGIN
 IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM library_content_review_events) THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Content review events are append-only' USING ERRCODE='23514'; END IF;
 -- Match the application lock order: identity first, then exact revision.
 SELECT * INTO c FROM library_content WHERE id=NEW.content_id FOR UPDATE;
 SELECT * INTO r FROM library_content_revisions WHERE id=NEW.revision_id AND content_id=NEW.content_id FOR UPDATE;
 IF r.id IS NULL OR c.id IS NULL THEN RAISE EXCEPTION 'Unknown content/revision pair' USING ERRCODE='23514'; END IF;
 IF r.version<>c.head_version THEN RAISE EXCEPTION 'Obsolete content revision' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS (SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id
  WHERE u.id=NEW.actor_user_id AND u.account_status='active' AND NOT u.is_guest
   AND ur.role=CASE WHEN NEW.decision='submitted' THEN 'creator' ELSE 'admin' END)
 THEN RAISE EXCEPTION 'Active actor capability required' USING ERRCODE='23514'; END IF;
 IF NEW.decision='submitted' THEN
  IF r.status<>'draft' OR c.owner_id<>NEW.actor_user_id OR r.category IS NULL THEN
   RAISE EXCEPTION 'Owner can submit a classified current draft only' USING ERRCODE='23514'; END IF;
 ELSE
  IF r.status<>'submitted' OR c.owner_id=NEW.actor_user_id THEN
   RAISE EXCEPTION 'Review requires an independent Admin and exact submission' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.decided_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER library_review_event_guard BEFORE INSERT OR UPDATE OR DELETE ON library_content_review_events FOR EACH ROW EXECUTE FUNCTION guard_library_review_event();
CREATE TRIGGER library_review_event_no_truncate BEFORE TRUNCATE ON library_content_review_events FOR EACH STATEMENT EXECUTE FUNCTION guard_library_review_event();
CREATE FUNCTION apply_library_review_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE library_content_revisions SET status=NEW.decision WHERE id=NEW.revision_id AND content_id=NEW.content_id;
 RETURN NEW;
END $$;
CREATE TRIGGER library_review_event_apply AFTER INSERT ON library_content_review_events FOR EACH ROW EXECUTE FUNCTION apply_library_review_event();

CREATE OR REPLACE FUNCTION protect_library_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.created_at<>OLD.created_at OR NEW.head_version<>OLD.head_version+1 THEN
  RAISE EXCEPTION 'Content ownership is immutable and heads advance one revision' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM library_content_revisions WHERE content_id=OLD.id AND version=OLD.head_version AND status IN ('submitted','archived')) THEN
  RAISE EXCEPTION 'Submitted or archived heads cannot advance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
`;
export default { id: '043_content_review', async up(client) { await client.query(contentReviewSql); } } satisfies Migration;
