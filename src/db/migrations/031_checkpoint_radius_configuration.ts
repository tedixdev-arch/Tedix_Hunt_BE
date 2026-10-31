import type { Migration } from './types.js';

export const checkpointRadiusSql = `
-- Null identifies historical snapshots; no UPDATE/backfill of existing Hunts.
ALTER TABLE hunts ADD COLUMN checkpoint_radius_configuration JSONB
 CHECK(checkpoint_radius_configuration IS NULL OR jsonb_typeof(checkpoint_radius_configuration)='object');
CREATE FUNCTION guard_checkpoint_radius_configuration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.checkpoint_radius_configuration IS DISTINCT FROM OLD.checkpoint_radius_configuration
 AND (OLD.status <> 'draft' OR EXISTS(SELECT 1 FROM hunt_checkpoint_identities WHERE hunt_id=OLD.id)) THEN
  RAISE EXCEPTION 'Hunt execution radii are frozen' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hunts_checkpoint_radius_configuration BEFORE UPDATE ON hunts
 FOR EACH ROW EXECUTE FUNCTION guard_checkpoint_radius_configuration();
`;
const migration: Migration = {
  id: '031_checkpoint_radius_configuration',
  async up(client) { await client.query(checkpointRadiusSql); },
};
export default migration;
