import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { fail, record, snapshotCheckpoints, type SnapshotCheckpoint } from '../domain/participantAccess.js';

export interface ParticipantCheckpointStatus {
  checkpointId: string;
  kind: 'regular' | 'finish';
  accessState: 'not_yet_accessible' | 'eligible_for_proximity' | 'proximity_verified';
  gameplayCompleted: false;
  mayAccessGameplay: false;
  verifiedAt: Date | null;
}
export interface ParticipantHuntContext {
  huntId: string; participantId: string; joinedAt: Date; huntStatus: string; templateVersion: number;
  enrollmentPolicy: 'existing_members_only'; proximityPolicy: 'unresolved';
  checkpoints: ParticipantCheckpointStatus[];
}

/** Every access path locks Hunt first. Lifecycle writers already update/lock that row.
 * Future completion/suspension writers must use the same order and recheck grants.
 */
async function withContext<T>(huntId: string, userId: string, code: string | undefined,
  action: (context: ParticipantHuntContext, points: Map<string, SnapshotCheckpoint>, client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: hunts } = await client.query(`SELECT *, encode(digest(CASE WHEN checkpoint_radius_configuration IS NULL THEN template_snapshot::text ELSE template_snapshot::text || checkpoint_radius_configuration::text END,'sha256'),'hex') AS snapshot_digest
      FROM hunts WHERE id=$1 FOR UPDATE`, [huntId]);
    const hunt = hunts[0];
    if (!hunt) return fail(404, 'not_found');
    const { rows: participants } = await client.query('SELECT * FROM hunt_participants WHERE hunt_id=$1 AND user_id=$2 FOR UPDATE', [huntId, userId]);
    const participant = participants[0];
    // A UUID or professional role is never enrollment authority. A code does not create an invitation.
    if (code !== undefined && hunt.access_code !== code) return fail(404, 'not_found');
    if (!participant && code === undefined) return fail(404, 'not_found');
    if (!['published','active','paused'].includes(hunt.status)) return fail(409, 'invalid_hunt_state');
    if (!participant) return fail(422, 'enrollment_policy_unresolved');
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
    const { rows: states } = await client.query(`SELECT c.id,c.kind,a.state,a.verified_at FROM hunt_checkpoint_identities c
      JOIN participant_checkpoint_access a ON a.hunt_id=c.hunt_id AND a.checkpoint_id=c.id AND a.snapshot_digest=c.snapshot_digest
      WHERE c.hunt_id=$1 AND a.participant_id=$2 ORDER BY c.ordinal`, [huntId, participant.id]);
    const context: ParticipantHuntContext = {
      huntId, participantId: participant.id, joinedAt: participant.joined_at, huntStatus: hunt.status, templateVersion: hunt.template_version,
      enrollmentPolicy: 'existing_members_only', proximityPolicy: 'unresolved',
      checkpoints: states.map(s => ({ checkpointId: s.id, kind: s.kind, accessState: s.state,
        gameplayCompleted: false, mayAccessGameplay: false, verifiedAt: s.verified_at })),
    };
    const points = new Map(checkpoints.map((c, i) => [c.id, definitions[i]]));
    const result = await action(context, points, client);
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
  verify: (huntId: string, userId: string, checkpointId: string) => withContext(huntId, userId, undefined, async (context, points) => {
    const checkpoint = context.checkpoints.find(c => c.checkpointId === checkpointId);
    if (!checkpoint) return fail(404, 'not_found');
    if (context.huntStatus !== 'active') return fail(409, 'invalid_hunt_state');
    if (checkpoint.accessState === 'not_yet_accessible') return fail(409, 'checkpoint_not_eligible');
    if (!points.get(checkpointId)?.point) return fail(422, 'checkpoint_geography_unavailable');
    // D1 age/accuracy/uncertainty and D6 suspension/grant validity are unresolved.
    // No environment variable or request field can approve policy or persist a grant.
    return fail(422, 'proximity_policy_unresolved');
  }),
};
