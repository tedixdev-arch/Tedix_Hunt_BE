import { pool } from '../lib/postgres.js';

export interface ProposalInput {
  countryCode: string;
  name: string;
  administrativeContext: string;
  latitude: number;
  longitude: number;
  explanation: string;
  evidenceReference: string;
}
export class ProposalError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}
const projection = `id, creator_user_id AS "creatorUserId", country_code AS "countryCode", name,
  administrative_context AS "administrativeContext", latitude, longitude, explanation,
  evidence_reference AS "evidenceReference", status, reviewer_user_id AS "reviewerUserId",
  decision_reason AS "decisionReason", created_at AS "createdAt", decided_at AS "decidedAt", locality_id AS "localityId"`;

export const LocalityProposals = {
  async submit(input: ProposalInput, creatorId: string) {
    try {
      return (await pool.query(`INSERT INTO locality_proposals
        (creator_user_id,country_code,name,administrative_context,latitude,longitude,explanation,evidence_reference)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${projection}`,
      [creatorId,input.countryCode,input.name,input.administrativeContext,input.latitude,input.longitude,input.explanation,input.evidenceReference])).rows[0];
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
          AND regexp_replace(lower(name), '[^[:alnum:]]', '', 'g') = regexp_replace(lower($2::text), '[^[:alnum:]]', '', 'g') LIMIT 1`,
        [proposal.country_code, proposal.name]);
        if (duplicate.rowCount) throw new ProposalError('locality_duplicate_conflict', 409);
        localityId = (await client.query(`INSERT INTO localities
          (country_code,name,administrative_context,latitude,longitude,provenance)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [proposal.country_code,proposal.name,proposal.administrative_context,proposal.latitude,proposal.longitude,
          `Manual proposal ${id}; confirmed by Admin ${reviewerId}. Reason: ${reason}`])).rows[0].id;
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
