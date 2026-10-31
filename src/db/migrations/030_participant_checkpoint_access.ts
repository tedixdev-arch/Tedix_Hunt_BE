import type { Migration } from './types.js';

export const participantCheckpointAccessSql = `
ALTER TABLE hunt_participants ADD COLUMN access_snapshot_digest TEXT
  CHECK (access_snapshot_digest IS NULL OR access_snapshot_digest ~ '^[0-9a-f]{64}$');
ALTER TABLE hunt_participants ADD CONSTRAINT hunt_participants_access_scope_key UNIQUE(hunt_id,id,access_snapshot_digest);
CREATE TABLE hunt_checkpoint_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  snapshot_digest TEXT NOT NULL CHECK(snapshot_digest ~ '^[0-9a-f]{64}$'),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 101),
  kind TEXT NOT NULL CHECK(kind IN ('regular','finish')),
  UNIQUE(hunt_id,ordinal),
  UNIQUE(hunt_id,id,snapshot_digest)
);
CREATE TABLE participant_checkpoint_access (
  hunt_id UUID NOT NULL,
  participant_id UUID NOT NULL,
  checkpoint_id UUID NOT NULL,
  snapshot_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('not_yet_accessible','eligible_for_proximity','proximity_verified')),
  verified_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ,
  accuracy_meters DOUBLE PRECISION,
  distance_meters DOUBLE PRECISION,
  policy_revision TEXT,
  PRIMARY KEY(participant_id,checkpoint_id),
  FOREIGN KEY(hunt_id,participant_id,snapshot_digest) REFERENCES hunt_participants(hunt_id,id,access_snapshot_digest) ON DELETE CASCADE,
  FOREIGN KEY(hunt_id,checkpoint_id,snapshot_digest) REFERENCES hunt_checkpoint_identities(hunt_id,id,snapshot_digest) ON DELETE CASCADE,
  CHECK ((state = 'proximity_verified' AND verified_at IS NOT NULL AND observed_at IS NOT NULL
    AND accuracy_meters >= 0 AND accuracy_meters < 'Infinity'::float8 AND accuracy_meters IS NOT NULL
    AND distance_meters >= 0 AND distance_meters < 'Infinity'::float8 AND distance_meters IS NOT NULL
    AND policy_revision IS NOT NULL AND length(policy_revision)>0)
    OR (state <> 'proximity_verified' AND verified_at IS NULL AND observed_at IS NULL
      AND accuracy_meters IS NULL AND distance_meters IS NULL AND policy_revision IS NULL))
);
-- No JSON rewrite/backfill: pin the existing Hunt source once any Participant initializes access.
CREATE FUNCTION guard_participant_access_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.template_key,NEW.template_version,NEW.template_snapshot) IS DISTINCT FROM
     ROW(OLD.template_key,OLD.template_version,OLD.template_snapshot)
     AND EXISTS(SELECT 1 FROM hunt_checkpoint_identities WHERE hunt_id=OLD.id) THEN
    RAISE EXCEPTION 'Participant access pins the Hunt snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hunts_participant_access_snapshot BEFORE UPDATE ON hunts
  FOR EACH ROW EXECUTE FUNCTION guard_participant_access_snapshot();
`;
const migration: Migration = {
  id: '030_participant_checkpoint_access',
  async up(client) { await client.query(participantCheckpointAccessSql); },
};
export default migration;
