import { pool } from '../lib/postgres.js';
import { inheritedRadii, type CheckpointRadii } from '../domain/checkpointRadius.js';
import { mapHuntRow } from './Hunt.js';
import { LocalSelectionError } from './OrganizerLocalTemplate.js';

/** Same Hunt row lock as selection, publication, lifecycle and Participant initialization. */
export async function configureHuntRadii(id: string, actor: string, key: string, version: number, patch: Partial<CheckpointRadii>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = (await client.query('SELECT account_status,is_guest FROM users WHERE id=$1 FOR SHARE', [actor])).rows[0];
    if (!user || user.account_status !== 'active') throw new LocalSelectionError('unauthorized', 401);
    if (user.is_guest) throw new LocalSelectionError('forbidden', 403);
    const hunt = (await client.query('SELECT * FROM hunts WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!hunt) throw new LocalSelectionError('not_found', 404);
    if (!(await client.query("SELECT 1 FROM hunt_roles WHERE hunt_id=$1 AND user_id=$2 AND role='organizer' FOR SHARE", [id, actor])).rowCount)
      throw new LocalSelectionError('forbidden', 403);
    if (hunt.status !== 'draft') throw new LocalSelectionError('invalid_hunt_state');
    if (hunt.template_key !== key || hunt.template_version !== version || !hunt.template_snapshot)
      throw new LocalSelectionError('template_selection_stale');
    if ((await client.query('SELECT 1 FROM hunt_checkpoint_identities WHERE hunt_id=$1 LIMIT 1', [id])).rowCount)
      throw new LocalSelectionError('execution_configuration_pinned');
    const radii: CheckpointRadii = hunt.checkpoint_radius_configuration ?? inheritedRadii(hunt.template_snapshot);
    for (const point of patch.checkpointPositions ?? []) {
      const matches = radii.checkpointPositions.filter(p => p.checkpointNumber === point.checkpointNumber);
      if (matches.length !== 1) throw new LocalSelectionError('checkpoint_geography_unavailable', 422);
      matches[0].radiusMeters = point.radiusMeters;
    }
    if (patch.finishPoint) {
      if (!radii.finishPoint) throw new LocalSelectionError('checkpoint_geography_unavailable', 422);
      radii.finishPoint = patch.finishPoint;
    }
    const result = await client.query('UPDATE hunts SET checkpoint_radius_configuration=$2,updated_at=now() WHERE id=$1 RETURNING *', [id, radii]);
    await client.query('COMMIT');
    return mapHuntRow(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
