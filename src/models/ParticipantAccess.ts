import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { distanceMeters, evaluateProximity, fail, record, snapshotCheckpoints, type GpsObservation, type SnapshotCheckpoint } from '../domain/participantAccess.js';
import { GAMEPLAY_POLICY_REVISION, pilotProximityPolicy } from '../domain/gameplay.js';

export interface ParticipantCheckpointStatus {
  checkpointId: string;
  kind: 'regular' | 'finish';
  accessState: 'not_yet_accessible' | 'eligible_for_proximity' | 'proximity_verified';
  gameplayCompleted: boolean;
  mayAccessGameplay: boolean;
  verifiedAt: Date | null;
}
export interface ParticipantHuntContext {
  huntId: string; participantId: string; joinedAt: Date; huntStatus: string; templateVersion: number;
  enrollmentPolicy: 'organizer_invitation'; proximityPolicy: typeof GAMEPLAY_POLICY_REVISION;
  checkpoints: ParticipantCheckpointStatus[];
}
export interface ParticipantExecution {
  hunt: Record<string, any>; participant: Record<string, any>; execution: Record<string, any>;
}

/** Every access path locks Hunt first. Lifecycle writers already update/lock that row.
 * Future completion/suspension writers must use the same order and recheck grants.
 */
async function withContext<T>(huntId: string, userId: string, code: string | undefined,
  action: (context: ParticipantHuntContext, points: Map<string, SnapshotCheckpoint>, client: PoolClient, scope: ParticipantExecution) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: hunts } = await client.query(`SELECT *, encode(digest(CASE WHEN checkpoint_radius_configuration IS NULL THEN template_snapshot::text ELSE template_snapshot::text || checkpoint_radius_configuration::text END,'sha256'),'hex') AS snapshot_digest
      FROM hunts WHERE id=$1 FOR UPDATE`, [huntId]);
    const hunt = hunts[0];
    if (!hunt) return fail(404, 'not_found');
    const { rows: participants } = await client.query('SELECT * FROM hunt_participants WHERE hunt_id=$1 AND user_id=$2 FOR UPDATE', [huntId, userId]);
    let participant = participants[0];
    if (!['published','active','paused'].includes(hunt.status)) return fail(409, 'invalid_hunt_state');
    if (!participant) {
      if (code === undefined || !hunt.invitation_enabled || hunt.access_code !== code) return fail(404, 'not_found');
      if (hunt.status === 'paused') return fail(409, 'invalid_hunt_state');
      if (!Number.isInteger(hunt.capacity) || hunt.capacity < 1) return fail(409, 'capacity_unconfigured');
      const { rows: counts } = await client.query('SELECT count(*)::int AS count FROM hunt_participants WHERE hunt_id=$1', [huntId]);
      if (counts[0].count >= hunt.capacity) return fail(409, 'hunt_capacity_exceeded');
      const { rows } = await client.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES($1,$2) RETURNING *', [huntId,userId]);
      participant = rows[0];
    }
    if (!hunt.template_key || !Number.isInteger(hunt.template_version) || !hunt.snapshot_digest) return fail(409, 'snapshot_unavailable');
    if (participant.access_snapshot_digest !== null && participant.access_snapshot_digest !== hunt.snapshot_digest) return fail(409, 'snapshot_conflict');
    // Resolve an in-memory execution view; never rewrite the approved source snapshot.
    const execution = structuredClone(hunt.template_snapshot);
    const radii = hunt.checkpoint_radius_configuration;
    if (radii && record(execution) && record(execution.configuration)) {
      for (const point of Array.isArray(execution.configuration.checkpointPositions) ? execution.configuration.checkpointPositions : []) {
        if (!record(point)) continue;
        const radius = radii.checkpointPositions.find((p: any) => p.checkpointNumber === point.checkpointNumber)?.radiusMeters;
        if (typeof radius === 'number') point.radiusMeters = radius;
      }
      if (execution.configuration.finishPoint && radii.finishPoint)
        execution.configuration.finishPoint.radiusMeters = radii.finishPoint.radiusMeters;
    }
    const definitions = snapshotCheckpoints(execution, hunt.template_key, hunt.template_version);
    await client.query('UPDATE hunt_participants SET access_snapshot_digest=$2 WHERE id=$1 AND access_snapshot_digest IS NULL', [participant.id, hunt.snapshot_digest]);
    for (const point of definitions) {
      await client.query(`INSERT INTO hunt_checkpoint_identities(hunt_id,snapshot_digest,ordinal,kind) VALUES($1,$2,$3,$4)
        ON CONFLICT(hunt_id,ordinal) DO NOTHING`, [huntId, hunt.snapshot_digest, point.ordinal, point.kind]);
    }
    const { rows: checkpoints } = await client.query('SELECT * FROM hunt_checkpoint_identities WHERE hunt_id=$1 ORDER BY ordinal', [huntId]);
    if (checkpoints.length !== definitions.length || checkpoints.some((c, i) => c.snapshot_digest !== hunt.snapshot_digest ||
      c.ordinal !== definitions[i].ordinal || c.kind !== definitions[i].kind)) return fail(409, 'snapshot_conflict');
    await client.query(`INSERT INTO participant_checkpoint_access(hunt_id,participant_id,checkpoint_id,snapshot_digest,state)
      SELECT hunt_id,$2,id,snapshot_digest,CASE WHEN ordinal=1 THEN 'eligible_for_proximity' ELSE 'not_yet_accessible' END
      FROM hunt_checkpoint_identities WHERE hunt_id=$1 ON CONFLICT(participant_id,checkpoint_id) DO NOTHING`, [huntId, participant.id]);
    const { rows: states } = await client.query(`SELECT c.id,c.kind,a.state,a.verified_at,p.completed_at FROM hunt_checkpoint_identities c
      JOIN participant_checkpoint_access a ON a.hunt_id=c.hunt_id AND a.checkpoint_id=c.id AND a.snapshot_digest=c.snapshot_digest
      LEFT JOIN participant_checkpoint_progress p ON p.participant_id=a.participant_id AND p.checkpoint_id=c.id
      WHERE c.hunt_id=$1 AND a.participant_id=$2 ORDER BY c.ordinal`, [huntId, participant.id]);
    const context: ParticipantHuntContext = {
      huntId, participantId: participant.id, joinedAt: participant.joined_at, huntStatus: hunt.status, templateVersion: hunt.template_version,
      enrollmentPolicy: 'organizer_invitation', proximityPolicy: GAMEPLAY_POLICY_REVISION,
      checkpoints: states.map(s => ({ checkpointId: s.id, kind: s.kind, accessState: s.state,
        gameplayCompleted: s.completed_at !== null,
        mayAccessGameplay: hunt.status === 'active' && s.state === 'proximity_verified' && s.completed_at === null,
        verifiedAt: s.verified_at })),
    };
    const points = new Map(checkpoints.map((c, i) => [c.id, definitions[i]]));
    const result = await action(context, points, client, { hunt, participant, execution });
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export const ParticipantAccess = {
  context: (huntId: string, userId: string, code?: string) => withContext(huntId, userId, code, async context => context),
  checkpoint: (huntId: string, userId: string, checkpointId: string) => withContext(huntId, userId, undefined, async context => {
    const checkpoint = context.checkpoints.find(c => c.checkpointId === checkpointId);
    return checkpoint ?? fail(404, 'not_found');
  }),
  /** Pilot D1 grant: fresh, accurate observation inside the pinned effective radius. Grants persist until completion. */
  verify: (huntId: string, userId: string, checkpointId: string, observation: GpsObservation, now = Date.now()) =>
    withContext(huntId, userId, undefined, async (context, points, client, scope) => {
      const checkpoint = context.checkpoints.find(c => c.checkpointId === checkpointId);
      if (!checkpoint) return fail(404, 'not_found');
      if (context.huntStatus !== 'active') return fail(409, 'invalid_hunt_state');
      if (checkpoint.accessState === 'not_yet_accessible') return fail(409, 'checkpoint_not_eligible');
      if (checkpoint.accessState === 'proximity_verified') return checkpoint;
      const point = points.get(checkpointId)?.point;
      if (!point) return fail(422, 'checkpoint_geography_unavailable');
      const outcome = evaluateProximity(observation, point, pilotProximityPolicy(), now);
      if (outcome !== 'verified') return fail(422, `proximity_${outcome}`);
      const accuracy = observation.accuracyMeters;
      await client.query(`UPDATE participant_checkpoint_access SET state='proximity_verified', verified_at=now(), observed_at=$3,
        accuracy_meters=$4, distance_meters=$5, policy_revision=$6 WHERE participant_id=$1 AND checkpoint_id=$2 AND state='eligible_for_proximity'`,
        [scope.participant.id, checkpointId, observation.observedAt, accuracy, distanceMeters(observation, point), GAMEPLAY_POLICY_REVISION]);
      await client.query('UPDATE hunt_participants SET last_activity_at=now(), started_at=COALESCE(started_at, now()) WHERE id=$1', [scope.participant.id]);
      return { ...checkpoint, accessState: 'proximity_verified' as const, verifiedAt: new Date(), mayAccessGameplay: true };
    }),
  /** Gameplay executor entry point. Locks Hunt then membership in the shared order. */
  withExecution: <T>(huntId: string, userId: string,
    action: (context: ParticipantHuntContext, points: Map<string, SnapshotCheckpoint>, client: PoolClient, scope: ParticipantExecution) => Promise<T>) =>
    withContext(huntId, userId, undefined, action),
};
