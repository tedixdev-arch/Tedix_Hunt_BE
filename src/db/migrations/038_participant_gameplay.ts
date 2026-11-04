import type { Migration } from './types.js';

/** Pilot Solo gameplay state (provisional D1/D3/D4/D6/D8 defaults, see docs/Participant_Gameplay_Pilot.md).
 * Every row is scoped to an existing membership and pinned checkpoint identity; snapshots are never rewritten.
 */
export const participantGameplaySql = `
ALTER TABLE hunt_participants
  ADD COLUMN started_at TIMESTAMPTZ,
  ADD COLUMN finished_at TIMESTAMPTZ,
  ADD COLUMN last_activity_at TIMESTAMPTZ;
ALTER TABLE participant_checkpoint_access ADD COLUMN granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE participant_checkpoint_progress (
  hunt_id UUID NOT NULL,
  participant_id UUID NOT NULL REFERENCES hunt_participants(id) ON DELETE CASCADE,
  checkpoint_id UUID NOT NULL REFERENCES hunt_checkpoint_identities(id) ON DELETE CASCADE,
  personal_attempts INTEGER NOT NULL DEFAULT 0 CHECK (personal_attempts >= 0),
  team_attempts INTEGER NOT NULL DEFAULT 0 CHECK (team_attempts >= 0),
  personal_solved_at TIMESTAMPTZ,
  team_solved_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (participant_id, checkpoint_id),
  FOREIGN KEY (hunt_id, participant_id) REFERENCES hunt_participants(hunt_id, id) ON DELETE CASCADE
);
CREATE TABLE participant_challenge_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES hunt_participants(id) ON DELETE CASCADE,
  checkpoint_id UUID NOT NULL REFERENCES hunt_checkpoint_identities(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('personal', 'team')),
  correct BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX participant_challenge_attempts_participant_idx ON participant_challenge_attempts(participant_id, created_at);
CREATE TABLE participant_score_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES hunt_participants(id) ON DELETE CASCADE,
  checkpoint_id UUID REFERENCES hunt_checkpoint_identities(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('starting_score', 'failed_attempt', 'first_attempt_bonus',
    'personal_solved', 'team_solved', 'finish_puzzle', 'mission_completion')),
  points INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (participant_id, event_key)
);
CREATE INDEX participant_score_events_hunt_idx ON participant_score_events(hunt_id, participant_id);
CREATE TABLE hunt_help_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hunt_id UUID NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL REFERENCES hunt_participants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('help', 'emergency')),
  message TEXT NOT NULL DEFAULT '' CHECK (length(message) <= 500),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((status = 'open' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL))
);
CREATE INDEX hunt_help_requests_hunt_idx ON hunt_help_requests(hunt_id, status, created_at);
`;

const migration: Migration = {
  id: '038_participant_gameplay',
  async up(client) { await client.query(participantGameplaySql); },
};
export default migration;
