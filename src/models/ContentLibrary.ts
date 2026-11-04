import { pool } from '../lib/postgres.js';
import { ContentError, validateContent } from '../domain/contentLibrary.js';
const select = `SELECT c.id AS "contentId", c.owner_id AS "ownerId",c.created_at AS "createdAt",
 r.created_at AS "updatedAt",r.id AS "revisionId",r.version,r.status,r.exercise,r.category,r.curriculum,
 jsonb_strip_nulls(jsonb_build_object('scope',r.geographic_scope,'countryCode',r.country_code,'admin1Code',r.admin1_code,'geographicId',r.geographic_id::text)) AS geography
 FROM library_content c JOIN library_content_revisions r ON r.content_id=c.id`;
export const ContentLibrary = {
 async get(owner: string,id: string,revision?: string) {
  const result = await pool.query(`${select} WHERE c.owner_id=$1 AND c.id=$2 AND ${revision ? 'r.id=$3' : 'r.version=c.head_version'}`,revision?[owner,id,revision]:[owner,id]);
  if (!result.rows.length) throw new ContentError('not_found',404);
  return result.rows[0];
 },
 async list(owner:string,limit:number,after?:string) {
  const rows=(await pool.query(`${select} WHERE c.owner_id=$1 AND r.version=c.head_version AND r.status='draft'
   AND ($2::uuid IS NULL OR c.id>$2::uuid) ORDER BY c.id LIMIT $3`,[owner,after??null,limit+1])).rows;
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
    const current=(await db.query(`SELECT c.head_version,r.* FROM library_content c JOIN library_content_revisions r
     ON r.content_id=c.id AND r.version=c.head_version WHERE c.id=$1 AND c.owner_id=$2 FOR UPDATE OF c`,[id,owner])).rows[0];
    if (!current) throw new ContentError('not_found',404);
    if (current.id!==base) throw new ContentError('revision_conflict',409);
    if (current.status==='archived' || (!clone && current.status!=='draft')) throw new ContentError('revision_required',409);
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
   const result=(await db.query(`${select} WHERE c.id=$1 AND r.id=$2`,[id,revision])).rows[0];
   await db.query('COMMIT'); return result;
  } catch(error) {
   await db.query('ROLLBACK');
   if ((error as {code?:string}).code==='23503') throw new ContentError('unknown_geographic_identifier',400);
   throw error;
  } finally {db.release();}
 }
};
