import { pool } from '../lib/postgres.js';
import { ContentError, validateContentSubmission } from '../domain/contentLibrary.js';
import { contentSelect } from './ContentLibrary.js';

type Decision = 'submitted' | 'approved' | 'changes_requested';
export const ContentReview = {
 async queue(limit: number, after?: string) {
  // Queue deliberately omits answers and owner PII. Detail is exact-revision scoped.
  const rows = (await pool.query(`SELECT c.id AS "contentId",r.id AS "revisionId",r.version,
   r.status,r.exercise->>'title' AS title,r.exercise->>'classification' AS classification,
   r.exercise->>'type' AS type,r.category,r.curriculum,r.geographic_scope AS "geographicScope",
   r.country_code AS "countryCode",r.admin1_code AS "admin1Code",r.geographic_id::text AS "geographicId",
   e.decided_at AS "submittedAt"
   FROM library_content c JOIN library_content_revisions r ON r.content_id=c.id AND r.version=c.head_version
   JOIN library_content_review_events e ON e.revision_id=r.id AND e.decision='submitted'
   WHERE r.status='submitted' AND ($1::uuid IS NULL OR r.id>$1::uuid) ORDER BY r.id LIMIT $2`, [after ?? null, limit + 1])).rows;
  const more = rows.length > limit; rows.splice(limit);
  return { items: rows, nextAfter: more ? rows.at(-1).revisionId : null };
 },
 async detail(id: string, revision: string) {
  const row = (await pool.query(`${contentSelect} WHERE c.id=$1 AND r.id=$2 AND r.status='submitted' AND r.version=c.head_version`, [id, revision])).rows[0];
  if (!row) throw new ContentError('not_found', 404);
  return row;
 },
 async transition(actor: string, id: string, revision: string, decision: Decision, comment: string | null = null) {
  const db = await pool.connect();
  try {
   await db.query('BEGIN');
   const c = (await db.query('SELECT * FROM library_content WHERE id=$1 FOR UPDATE', [id])).rows[0];
   if (!c || (decision === 'submitted' && c.owner_id !== actor)) throw new ContentError('not_found', 404);
   const r = (await db.query(`${contentSelect} WHERE c.id=$1 AND r.id=$2 FOR UPDATE OF r`, [id, revision])).rows[0];
   if (!r) throw new ContentError('not_found', 404);
   const role = decision === 'submitted' ? 'creator' : 'admin';
   const authorized = (await db.query(`SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id=u.id
    WHERE u.id=$1 AND ur.role=$2 AND u.account_status='active' AND NOT u.is_guest`, [actor, role])).rowCount;
   if (!authorized) throw new ContentError('forbidden', 403);
   if (decision !== 'submitted' && c.owner_id === actor) throw new ContentError('content_self_review_forbidden', 403);
   if (r.version !== c.head_version || r.status !== (decision === 'submitted' ? 'draft' : 'submitted')) {
    throw new ContentError('revision_conflict', 409);
   }
   // Re-run canonical and metadata checks on the locked exact stored payload for
   // submission and either review decision. Geography is protected by catalog FKs.
   validateContentSubmission({exercise:r.exercise,category:r.category,curriculum:r.curriculum,geography:r.geography});
   await db.query(`INSERT INTO library_content_review_events(content_id,revision_id,actor_user_id,decision,comment)
    VALUES ($1,$2,$3,$4,$5)`, [id, revision, actor, decision, comment]);
   const result = (await db.query(`${contentSelect} WHERE c.id=$1 AND r.id=$2`, [id, revision])).rows[0];
   await db.query('COMMIT');
   return result;
  } catch (error) {
   await db.query('ROLLBACK');
   if ((error as {code?:string}).code === '23505') throw new ContentError('revision_conflict', 409);
   throw error;
  } finally { db.release(); }
 }
};
