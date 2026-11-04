import { pool } from '../lib/postgres.js';
import { ContentError, validateContent } from '../domain/contentLibrary.js';
export const contentSelect = `SELECT c.id AS "contentId", c.owner_id AS "ownerId",c.created_at AS "createdAt",
 r.created_at AS "updatedAt",r.id AS "revisionId",r.version,r.status,
 (SELECT COALESCE(jsonb_agg(jsonb_build_object('eventId',e.id,'contentId',e.content_id,'revisionId',e.revision_id,
 'actorUserId',e.actor_user_id,'decision',e.decision,'comment',e.comment,'decidedAt',e.decided_at)
 ORDER BY e.decided_at,e.id),'[]'::jsonb) FROM library_content_review_events e WHERE e.revision_id=r.id) AS "reviewEvents",r.exercise,r.category,r.curriculum,
 jsonb_strip_nulls(jsonb_build_object('scope',r.geographic_scope,'countryCode',r.country_code,'admin1Code',r.admin1_code,'geographicId',r.geographic_id::text)) AS geography
 FROM library_content c JOIN library_content_revisions r ON r.content_id=c.id`;
export const ContentLibrary = {
 async get(owner: string,id: string,revision?: string) {
  const result = await pool.query(`${contentSelect} WHERE c.owner_id=$1 AND c.id=$2 AND ${revision ? 'r.id=$3' : 'r.version=c.head_version'}`,revision?[owner,id,revision]:[owner,id]);
  if (!result.rows.length) throw new ContentError('not_found',404);
  return result.rows[0];
 },
 async list(owner:string,limit:number,after?:string,all=false) {
  const rows=(await pool.query(`${contentSelect} WHERE c.owner_id=$1 AND r.version=c.head_version AND ($4::boolean OR r.status='draft')
   AND ($2::uuid IS NULL OR c.id>$2::uuid) ORDER BY c.id LIMIT $3`,[owner,after??null,limit+1,all])).rows;
  const more=rows.length>limit; rows.splice(limit);
  return {items:rows,nextAfter:more?rows.at(-1).contentId:null};
 },
 async save(owner:string,input:unknown,id?:string,base?:string,clone=false) {
  // Validate outside transaction where possible; trusted clones are validated after locking the head.
  let data = clone ? undefined : validateContent(input);
  const db=await pool.connect();
  try {
   await db.query('BEGIN');
   let version=1;
   if (id) {
    // Lock identity before reading its head revision: a joined locking SELECT can
    // lose the old join row after waiting on another save and incorrectly return 404.
    const identity=(await db.query('SELECT head_version FROM library_content WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,owner])).rows[0];
    if (!identity) throw new ContentError('not_found',404);
    const revision=(await db.query('SELECT * FROM library_content_revisions WHERE content_id=$1 AND version=$2',[id,identity.head_version])).rows[0];
    const current={...revision,head_version:identity.head_version};
    if (current.id!==base) throw new ContentError('revision_conflict',409);
    if (current.status==='archived' || current.status==='submitted' || (!clone && current.status!=='draft')) throw new ContentError('revision_required',409);
    version=current.head_version+1;
    if (clone) data=validateContent({exercise:current.exercise,category:current.category,curriculum:current.curriculum,
     geography:{scope:current.geographic_scope,...(current.country_code?{countryCode:current.country_code}:{}),
      ...(current.admin1_code?{admin1Code:current.admin1_code}:{}),...(current.geographic_id?{geographicId:String(current.geographic_id)}:{})}});
   } else {
    id=(await db.query('INSERT INTO library_content(owner_id,head_version) VALUES ($1,1) RETURNING id',[owner])).rows[0].id as string;
   }
   const d=data!,g=d.geography;
   const revision=(await db.query(`INSERT INTO library_content_revisions(content_id,version,exercise,category,curriculum,geographic_scope,country_code,admin1_code,geographic_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[id,version,JSON.stringify(d.exercise),d.category,JSON.stringify(d.curriculum),g.scope,g.countryCode??null,g.admin1Code??null,g.geographicId??null])).rows[0].id;
   if(version>1) await db.query('UPDATE library_content SET head_version=$2,updated_at=now() WHERE id=$1',[id,version]);
   const result=(await db.query(`${contentSelect} WHERE c.id=$1 AND r.id=$2`,[id,revision])).rows[0];
   await db.query('COMMIT'); return result;
  } catch(error) {
   await db.query('ROLLBACK');
   if ((error as {code?:string}).code==='23503') throw new ContentError('unknown_geographic_identifier',400);
   throw error;
  } finally {db.release();}
 }
};
