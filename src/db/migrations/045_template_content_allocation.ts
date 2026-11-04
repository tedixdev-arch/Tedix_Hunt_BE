import type { Migration } from './types.js';

// JSONB remains the existing immutable Template artifact. No new Template table or backfill.
export const allocationSql = `
CREATE FUNCTION protect_template_library_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cp jsonb; a record; revision library_content_revisions%ROWTYPE; seen text[] := ARRAY[]::text[];
BEGIN
 FOR cp IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.content->'checkpoints')='array'
   THEN NEW.content->'checkpoints' ELSE '[]'::jsonb END) LOOP
  IF NOT(cp ? 'libraryAllocations') THEN CONTINUE; END IF;
  IF TG_OP<>'INSERT' OR NEW.category IS NULL OR jsonb_typeof(cp->'libraryAllocations') IS DISTINCT FROM 'object'
    OR cp->'libraryAllocations'='{}'::jsonb THEN
   RAISE EXCEPTION 'Library allocations require a new classified immutable version' USING ERRCODE='23514'; END IF;
  FOR a IN SELECT * FROM jsonb_each(cp->'libraryAllocations') LOOP
   SELECT * INTO revision FROM library_content_revisions r
    WHERE r.id::text=a.value->>'revisionId' AND r.content_id::text=a.value->>'contentId'
      AND r.status='approved' AND EXISTS(SELECT 1 FROM library_content_review_events e
        WHERE e.content_id=r.content_id AND e.revision_id=r.id AND e.decision='approved');
   IF revision.id IS NULL OR a.key NOT IN ('personal','team') OR a.value->>'mode' NOT IN ('specific','random')
     OR a.value->>'mode' IS NULL OR a.value->'version' IS DISTINCT FROM to_jsonb(revision.version)
     OR a.value->>'classification' IS DISTINCT FROM a.key
     OR a.value->>'type' IS DISTINCT FROM revision.exercise->>'type'
     OR revision.exercise->>'classification' IS DISTINCT FROM a.key
     OR ((cp->'customExercises'->a.key) - ARRAY['id','owner']) IS DISTINCT FROM revision.exercise THEN
    RAISE EXCEPTION 'Library allocation must freeze the exact approval-backed canonical payload and identity' USING ERRCODE='23514'; END IF;
   IF a.key='personal' THEN
    IF revision.content_id::text=ANY(seen) THEN
     RAISE EXCEPTION 'Duplicate Personal Content identity across checkpoints' USING ERRCODE='23514'; END IF;
    seen:=array_append(seen,revision.content_id::text);
   END IF;
  END LOOP;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER hunt_template_versions_library_allocations BEFORE INSERT OR UPDATE ON hunt_template_versions
 FOR EACH ROW EXECUTE FUNCTION protect_template_library_allocations();
`;
const migration: Migration = {
  id: '045_template_content_allocation',
  async up(client) { await client.query(allocationSql); },
};
export default migration;
