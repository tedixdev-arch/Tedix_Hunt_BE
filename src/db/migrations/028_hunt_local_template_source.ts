import type { Migration } from './types.js';

const migration: Migration = {
  id: '028_hunt_local_template_source',
  async up(client) {
    await client.query(`
ALTER TABLE hunts
 ADD COLUMN template_id UUID,
 ADD COLUMN template_locality_id UUID REFERENCES localities(id) ON DELETE RESTRICT,
 ADD COLUMN template_locality_snapshot JSONB,
 ADD CONSTRAINT hunts_local_source_pair_check CHECK (
  (template_id IS NULL AND template_locality_id IS NULL AND template_locality_snapshot IS NULL) OR
  (template_id IS NOT NULL AND template_key IS NOT NULL AND template_version IS NOT NULL
    AND template_snapshot IS NOT NULL AND template_locality_id IS NOT NULL AND template_locality_snapshot IS NOT NULL)
 ),
 ADD CONSTRAINT hunts_template_source_fkey FOREIGN KEY (template_id,template_version)
  REFERENCES hunt_template_versions(template_id,version) ON DELETE RESTRICT;

CREATE FUNCTION protect_hunt_local_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.template_id,NEW.template_key,NEW.template_version,NEW.template_snapshot,NEW.template_locality_id,NEW.template_locality_snapshot)
   IS NOT DISTINCT FROM
   ROW(OLD.template_id,OLD.template_key,OLD.template_version,OLD.template_snapshot,OLD.template_locality_id,OLD.template_locality_snapshot) THEN RETURN NEW; END IF;
  IF OLD.template_id IS NOT NULL AND (NEW.template_id IS NULL OR OLD.status<>'draft') THEN
   RAISE EXCEPTION 'Local Hunt source cannot be cleared or changed after draft' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.template_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM hunt_template_versions v JOIN hunt_templates t ON t.id=v.template_id
  WHERE v.template_id=NEW.template_id AND v.version=NEW.template_version
   AND t.key=NEW.template_key AND t.origin='creator' AND t.category='local'
   AND v.origin=t.origin AND v.category=t.category AND v.created_by_user_id=t.created_by_user_id
   AND v.content=NEW.template_snapshot AND v.locality_id=NEW.template_locality_id
   AND v.locality_snapshot=NEW.template_locality_snapshot
 ) THEN
  RAISE EXCEPTION 'Local Hunt source must equal one complete immutable artifact' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER hunts_local_source_protection BEFORE INSERT OR UPDATE ON hunts
 FOR EACH ROW EXECUTE FUNCTION protect_hunt_local_source();
    `);
  },
};
export default migration;
