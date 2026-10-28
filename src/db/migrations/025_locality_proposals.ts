import type { Migration } from './types.js';

const migration: Migration = {
  id: '025_locality_proposals',
  async up(client) {
    await client.query(`
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
    `);
  },
};

export default migration;
