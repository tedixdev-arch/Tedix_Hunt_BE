import type { Migration } from './types.js';

const migration: Migration = {
  id: '029_template_custom_exercises',
  async up(client) {
    // No record rewrite, library table or new lifecycle. Existing JSONB is sufficient.
    await client.query(`
CREATE FUNCTION protect_template_custom_exercises() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_key text;
  checkpoint jsonb;
  slot record;
  instance_ids text[] := ARRAY[]::text[];
  has_custom boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.content->'checkpoints')='array'
      THEN OLD.content->'checkpoints' ELSE '[]'::jsonb END) c WHERE c ? 'customExercises'
  ) THEN
    RAISE EXCEPTION 'Custom exercise version snapshots are immutable' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.content->'checkpoints')='array'
      THEN NEW.content->'checkpoints' ELSE '[]'::jsonb END) c WHERE c ? 'customExercises'
  ) INTO has_custom;
  IF NOT has_custom THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Custom exercises require a new immutable version' USING ERRCODE='23514';
  END IF;
  SELECT key INTO template_key FROM hunt_templates WHERE id=NEW.template_id FOR SHARE;
  IF NEW.content->>'key' IS DISTINCT FROM template_key
    OR NEW.content->'version' IS DISTINCT FROM to_jsonb(NEW.version) THEN
    RAISE EXCEPTION 'Custom content must belong to this Template version' USING ERRCODE='23514';
  END IF;
  FOR checkpoint IN SELECT value FROM jsonb_array_elements(NEW.content->'checkpoints') LOOP
    IF NOT (checkpoint ? 'customExercises') THEN CONTINUE; END IF;
    IF jsonb_typeof(checkpoint->'customExercises') IS DISTINCT FROM 'object'
      OR checkpoint->'customExercises' = '{}'::jsonb THEN
      RAISE EXCEPTION 'Invalid custom exercise slots' USING ERRCODE='23514';
    END IF;
    FOR slot IN SELECT * FROM jsonb_each(checkpoint->'customExercises') LOOP
      IF slot.key NOT IN ('personal','team')
        OR slot.value->>'classification' IS DISTINCT FROM slot.key
        OR slot.value->'schemaVersion' IS DISTINCT FROM '1'::jsonb
        OR slot.value->'owner' IS DISTINCT FROM jsonb_build_object('templateKey',template_key,'version',NEW.version)
        OR COALESCE(slot.value->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR slot.value->>'id' = ANY(instance_ids) THEN
        RAISE EXCEPTION 'Custom instance ownership, identity or classification mismatch' USING ERRCODE='23514';
      END IF;
      instance_ids := array_append(instance_ids,slot.value->>'id');
    END LOOP;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hunt_template_versions_custom_exercises BEFORE INSERT OR UPDATE ON hunt_template_versions
  FOR EACH ROW EXECUTE FUNCTION protect_template_custom_exercises();

CREATE FUNCTION protect_custom_template_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.key,NEW.origin,NEW.created_by_user_id) IS DISTINCT FROM
     ROW(OLD.id,OLD.key,OLD.origin,OLD.created_by_user_id) AND EXISTS (
    SELECT 1 FROM hunt_template_versions v,
      LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.content->'checkpoints')='array'
        THEN v.content->'checkpoints' ELSE '[]'::jsonb END) c
    WHERE v.template_id=OLD.id AND c ? 'customExercises'
  ) THEN
    RAISE EXCEPTION 'Custom Template identity and ownership are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hunt_templates_custom_identity BEFORE UPDATE ON hunt_templates
  FOR EACH ROW EXECUTE FUNCTION protect_custom_template_identity();
    `);
  },
};
export default migration;
