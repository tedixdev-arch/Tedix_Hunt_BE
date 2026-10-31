import { inheritedRadii } from '../domain/checkpointRadius.js';
import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { isTemplateContent } from '../domain/creatorTemplates.js';
import { projectTemplateGeography } from '../domain/huntTemplates.js';
import type { Locality } from './Geography.js';
import type { LocalitySnapshot } from './HuntTemplate.js';
import { mapHuntRow } from './Hunt.js';

export class LocalSelectionError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
export interface LocalSelection {
  templateId: string; version: number; countryCode: string; localityId: string;
}
export interface LocalArtifact {
  templateId: string; key: string; version: number; content: Record<string, unknown>;
  localityId: string; localitySnapshot: LocalitySnapshot; currentLocality: Locality;
}

// Identity, exact authority, retained evidence and live geography share a statement snapshot.
const artifactSelect = `SELECT t.id AS "templateId",t.key,v.version,v.content,
 t.origin,t.category,t.created_by_user_id,v.origin AS version_origin,v.category AS version_category,
 v.created_by_user_id AS version_owner,t.local_suspended_at,
 r.decision,r.reviewer_user_id,v.locality_id AS "localityId",v.locality_snapshot AS "localitySnapshot",
 jsonb_build_object('id',l.id,'countryCode',l.country_code,'countryDisplayName',c.display_name,
 'name',l.name,'administrativeContext',l.administrative_context,'latitude',l.latitude,
 'longitude',l.longitude,'active',l.active) AS "currentLocality"
 FROM hunt_templates t
 JOIN users owner ON owner.id=t.created_by_user_id
 LEFT JOIN hunt_template_versions v ON v.template_id=t.id AND v.version=COALESCE(t.local_approved_version,
   CASE WHEN t.status='approved' THEN t.submitted_version END)
 LEFT JOIN hunt_template_reviews r ON r.template_id=t.id AND r.version=v.version
 LEFT JOIN localities l ON l.id=v.locality_id LEFT JOIN countries c ON c.code=l.country_code`;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validSnapshot = (s: unknown, id: string): s is LocalitySnapshot => record(s)
 && Object.keys(s).length === 7 && s.id === id && typeof s.countryCode === 'string' && /^[A-Z]{2}$/.test(s.countryCode)
 && (['countryDisplayName','name','administrativeContext'] as const).every(k => typeof s[k] === 'string'
   && (s[k] as string).trim().length > 0 && (s[k] as string).length <= (k === 'countryDisplayName' ? 100 : 200))
 && typeof s.latitude === 'number' && Number.isFinite(s.latitude) && Math.abs(s.latitude) <= 90
 && typeof s.longitude === 'number' && Number.isFinite(s.longitude) && Math.abs(s.longitude) <= 180;

/** Shared by discovery, detail and the locked selection. No status/latest fallback. */
export function resolveLocalArtifact(row: any): { artifact: LocalArtifact | null; error: string } {
  const deny = (error = 'template_not_eligible') => ({ artifact: null, error });
  if (!row || row.origin !== 'creator' || row.category !== 'local' || !row.created_by_user_id
    || row.version_origin !== 'creator' || row.version_category !== 'local' || row.version_owner !== row.created_by_user_id
    || row.local_suspended_at != null || row.decision !== 'approved' || !row.reviewer_user_id
    || row.reviewer_user_id === row.created_by_user_id || !row.localityId
    || !validSnapshot(row.localitySnapshot, row.localityId) || !isTemplateContent(row.content,row.key,row.version)) return deny();
  const live = row.currentLocality;
  if (!live?.id || !live.countryDisplayName || !live.active) return deny('locality_unavailable');
  if (live.id !== row.localityId || row.localitySnapshot.countryCode !== live.countryCode
    || row.localitySnapshot.latitude !== live.latitude || row.localitySnapshot.longitude !== live.longitude) return deny('locality_geography_changed');
  try { projectTemplateGeography(row.content); } catch { return deny(); }
  return { artifact: { templateId: row.templateId,key: row.key,version: row.version,content: row.content,
    localityId: row.localityId,localitySnapshot: row.localitySnapshot,currentLocality: live }, error: '' };
}

export const artifactMetadata = (a: LocalArtifact) => ({ templateId:a.templateId,key:a.key,version:a.version,
  displayName:a.content.displayName,theme:a.content.theme,localityId:a.localityId,localitySnapshot:a.localitySnapshot });

export async function discoverLocalArtifacts(countryCode: string, localityId: string) {
  const { rows } = await pool.query(`SELECT
    EXISTS(SELECT 1 FROM countries WHERE code=$1) AS country,
    (SELECT jsonb_build_object('countryCode',country_code,'active',active) FROM localities WHERE id=$2) AS locality,
    COALESCE((SELECT jsonb_agg(a ORDER BY a.key COLLATE "C",a."templateId") FROM (${artifactSelect}
      WHERE t.origin='creator' AND t.category='local' AND v.locality_id=$2) a),'[]'::jsonb) AS artifacts`,[countryCode,localityId]);
  const context = rows[0];
  if (!context.country) throw new LocalSelectionError('invalid_input',400);
  if (!context.locality || context.locality.countryCode !== countryCode) throw new LocalSelectionError('not_found',404);
  if (!context.locality.active) throw new LocalSelectionError('locality_unavailable');
  return (context.artifacts as any[]).flatMap(row => {
    const {artifact} = resolveLocalArtifact(row);
    return artifact && artifact.localitySnapshot.countryCode === countryCode ? [artifact] : [];
  });
}

export async function selectLocalTemplate(huntId: string, actorId: string, expected: LocalSelection) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Account writers lock users before deleting roles. Role-only deletes need no users lock.
    const actor = (await client.query(`SELECT account_status,is_guest FROM users WHERE id=$1 FOR SHARE`,[actorId])).rows[0];
    if (!actor || actor.account_status !== 'active') throw new LocalSelectionError('unauthorized',401);
    if (actor.is_guest || !(await client.query(`SELECT 1 FROM user_roles WHERE user_id=$1 AND role='organizer' FOR SHARE`,[actorId])).rowCount)
      throw new LocalSelectionError('forbidden',403);
    const hunt = (await client.query('SELECT * FROM hunts WHERE id=$1 FOR UPDATE',[huntId])).rows[0];
    if (!hunt) throw new LocalSelectionError('not_found',404);
    // Parent before child also agrees with Hunt deletion/cascade ordering.
    const role = await client.query(`SELECT 1 FROM hunt_roles WHERE hunt_id=$1 AND user_id=$2 AND role='organizer' FOR SHARE`,[huntId,actorId]);
    if (!role.rowCount) throw new LocalSelectionError('forbidden',403);
    if (hunt.status !== 'draft') throw new LocalSelectionError('invalid_hunt_state');
    await client.query('SELECT id FROM hunt_templates WHERE id=$1 FOR UPDATE',[expected.templateId]);
    // The identity lock freezes authority/evidence; then lock geography in the common writer order.
    let row = (await client.query(`${artifactSelect} WHERE t.id=$1`,[expected.templateId])).rows[0];
    if (!row || !row.localityId || !validSnapshot(row.localitySnapshot,row.localityId)) throw new LocalSelectionError('template_not_eligible');
    await lockGeography(client,row.localitySnapshot.countryCode,row.localityId);
    row = (await client.query(`${artifactSelect} WHERE t.id=$1`,[expected.templateId])).rows[0];
    const {artifact,error} = resolveLocalArtifact(row);
    if (!artifact) throw new LocalSelectionError(error);
    if (artifact.version !== expected.version) throw new LocalSelectionError('template_selection_stale');
    if (artifact.localityId !== expected.localityId.toLowerCase() || artifact.localitySnapshot.countryCode !== expected.countryCode)
      throw new LocalSelectionError('template_not_eligible');
    const result = await client.query(`UPDATE hunts SET template_id=$2,template_key=$3,template_version=$4,
      template_snapshot=$5,template_locality_id=$6,template_locality_snapshot=$7,checkpoint_radius_configuration=$8,updated_at=now()
      WHERE id=$1 RETURNING *`,[huntId,artifact.templateId,artifact.key,artifact.version,artifact.content,artifact.localityId,artifact.localitySnapshot,inheritedRadii(artifact.content)]);
    await client.query('COMMIT');
    return mapHuntRow(result.rows[0]);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function lockGeography(client: PoolClient, countryCode: string, localityId: string) {
  await client.query('SELECT code FROM countries WHERE code=$1 FOR SHARE',[countryCode]);
  await client.query('SELECT id FROM localities WHERE id=$1 FOR SHARE',[localityId]);
}
