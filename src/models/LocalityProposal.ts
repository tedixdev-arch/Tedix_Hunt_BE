import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { normalizeCityName } from '../domain/geographicNames.js';
import { placeIdentity } from '../domain/geographicRegions.js';

export interface ProposalInput {
  countryCode: string;
  name: string;
  administrativeContext: string;
  latitude: number;
  longitude: number;
  explanation: string;
  evidenceReference: string;
  /** GeoNames admin1 region; required when the country's catalog has regions. */
  admin1Code?: string;
}
export class ProposalError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
const projection = `id, creator_user_id AS "creatorUserId", country_code AS "countryCode", name,
  administrative_context AS "administrativeContext", latitude, longitude, explanation,
  evidence_reference AS "evidenceReference", status, reviewer_user_id AS "reviewerUserId",
  decision_reason AS "decisionReason", created_at AS "createdAt", decided_at AS "decidedAt", locality_id AS "localityId", admin1_code AS "admin1Code",
  (SELECT display_name FROM geographic_regions r WHERE r.country_code=locality_proposals.country_code
    AND r.admin1_code=locality_proposals.admin1_code) AS "regionDisplayName"`;

/**
 * Proposals are only for places missing from the GeoNames list. A same-name catalog city in the same
 * region (or anywhere in the country when no region applies) must be registered by an Admin instead.
 */
async function catalogMatch(db: Pick<PoolClient, 'query'>, countryCode: string, name: string, admin1Code: string | null) {
  return (await db.query(`SELECT g.geoname_id::text AS "geographicId" FROM geographic_city_names n
    JOIN geographic_cities g ON g.geoname_id=n.geoname_id
    WHERE n.country_code=$1 AND regexp_replace(n.normalized_name,'[^[:alnum:]]','','g')=$2
      AND ($3::text IS NULL OR g.admin1_code=$3) LIMIT 1`,
  [countryCode, placeIdentity(normalizeCityName(name)), admin1Code])).rowCount! > 0;
}

/** Region is validated against the stored admin1 dictionary; required whenever the country has one. */
async function checkRegion(db: Pick<PoolClient, 'query'>, countryCode: string, admin1Code: string | undefined | null) {
  if (admin1Code) {
    const found = await db.query('SELECT 1 FROM geographic_regions WHERE country_code=$1 AND admin1_code=$2', [countryCode, admin1Code]);
    if (!found.rowCount) throw new ProposalError('invalid_input', 400);
    return;
  }
  const hasRegions = await db.query('SELECT 1 FROM geographic_regions WHERE country_code=$1 LIMIT 1', [countryCode]);
  if (hasRegions.rowCount) throw new ProposalError('region_required', 400);
}

export const LocalityProposals = {
  async submit(input: ProposalInput, creatorId: string) {
    const admin1Code = input.admin1Code ?? null;
    await checkRegion(pool, input.countryCode, admin1Code);
    if (await catalogMatch(pool, input.countryCode, input.name, admin1Code)) throw new ProposalError('catalog_city_exists', 409);
    try {
      return (await pool.query(`INSERT INTO locality_proposals
        (creator_user_id,country_code,name,administrative_context,latitude,longitude,explanation,evidence_reference,admin1_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${projection}`,
      [creatorId,input.countryCode,input.name,input.administrativeContext,input.latitude,input.longitude,input.explanation,input.evidenceReference,admin1Code])).rows[0];
    } catch (error) {
      if ((error as { code?: string }).code === '23503') throw new ProposalError('invalid_input', 400);
      throw error;
    }
  },
  async mine(creatorId: string) {
    return (await pool.query(`SELECT ${projection} FROM locality_proposals WHERE creator_user_id=$1 ORDER BY created_at DESC,id`, [creatorId])).rows;
  },
  async pending() {
    return (await pool.query(`SELECT ${projection} FROM locality_proposals WHERE status='pending' ORDER BY created_at,id`)).rows;
  },
  async decide(id: string, reviewerId: string, decision: 'approved' | 'rejected', reason: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const proposal = (await client.query('SELECT * FROM locality_proposals WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!proposal) throw new ProposalError('not_found', 404);
      if (proposal.status !== 'pending') throw new ProposalError('proposal_not_reviewable', 409);
      if (proposal.creator_user_id === reviewerId) throw new ProposalError('forbidden', 403);
      let localityId: string | null = null;
      if (decision === 'approved') {
        // All new catalog writers must lock this country before duplicate check + insertion.
        await client.query('SELECT code FROM countries WHERE code=$1 FOR UPDATE', [proposal.country_code]);
        const duplicate = await client.query(`SELECT id FROM localities WHERE country_code=$1
          AND regexp_replace(lower(name), '[^[:alnum:]]', '', 'g') = regexp_replace(lower($2::text), '[^[:alnum:]]', '', 'g')
          AND regexp_replace(lower(administrative_context), '[^[:alnum:]]', '', 'g') = regexp_replace(lower($3::text), '[^[:alnum:]]', '', 'g') LIMIT 1`,
        [proposal.country_code, proposal.name, proposal.administrative_context]);
        if (duplicate.rowCount) throw new ProposalError('locality_duplicate_conflict', 409);
        // The catalog may have gained this place since submission: register that city instead.
        if (await catalogMatch(client, proposal.country_code, proposal.name, proposal.admin1_code)) {
          throw new ProposalError('catalog_city_exists', 409);
        }
        localityId = (await client.query(`INSERT INTO localities
          (country_code,name,administrative_context,latitude,longitude,provenance,admin1_code)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [proposal.country_code,proposal.name,proposal.administrative_context,proposal.latitude,proposal.longitude,
          `Manual proposal ${id}; confirmed by Admin ${reviewerId}. Reason: ${reason}`,proposal.admin1_code])).rows[0].id;
      }
      const result = await client.query(`UPDATE locality_proposals SET status=$2,reviewer_user_id=$3,
        decision_reason=$4,decided_at=clock_timestamp(),locality_id=$5 WHERE id=$1 RETURNING ${projection}`,
      [id,decision,reviewerId,reason,localityId]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  },
};
