import { pool } from '../lib/postgres.js';
import { ContentError } from '../domain/contentLibrary.js';
import { approvedCursor, supportedMechanics, type ApprovedPage } from '../domain/approvedContent.js';

const supported = `((r.exercise->>'classification'='personal' AND r.exercise->>'type'=ANY($2::text[]))
 OR (r.exercise->>'classification'='team' AND r.exercise->>'type'=ANY($3::text[])))`;
const geography = `jsonb_strip_nulls(jsonb_build_object('scope',r.geographic_scope,'countryCode',r.country_code,
 'admin1Code',r.admin1_code,'geographicId',r.geographic_id::text))`;
const metadata = `c.id AS "contentId",r.id AS "revisionId",r.version,r.status,
 r.exercise->>'classification' AS classification,r.exercise->>'type' AS type,r.exercise->>'title' AS title,
 r.category,r.curriculum,${geography} AS geography`;

// Expand the tuple's 32-bit xmin using the CURRENT read's transaction epoch.
// Compare that full ID to the original page's horizon, including across xid wrap.
// Event rows are append-only. This excludes approvals still in flight at page one,
// even if they commit before the next page, without retaining a DB transaction.
const visibleApproval = `EXISTS(SELECT 1 FROM library_content_review_events e
 WHERE e.content_id=r.content_id AND e.revision_id=r.id AND e.decision='approved'
 AND pg_visible_in_snapshot((
  floor(h.current_xmax/4294967296)*4294967296
  +e.xmin::text::numeric
  -CASE WHEN e.xmin::text::numeric>mod(h.current_xmax,4294967296)
   THEN 4294967296 ELSE 0 END
 )::text::xid8,h.snapshot::pg_snapshot))`;

export const ApprovedContent = {
 async list({limit,filters:f,cursor}: ApprovedPage) {
  // Capture the visibility horizon in the same statement as the first page read.
  const result = await pool.query(`WITH horizon AS MATERIALIZED (
   SELECT COALESCE($1::text,pg_current_snapshot()::text) AS snapshot,
    pg_snapshot_xmax(pg_current_snapshot())::text::numeric AS current_xmax
  ), location AS MATERIALIZED (
   SELECT g.geoname_id,g.admin1_code FROM geographic_cities g
   WHERE g.geoname_id=$12::bigint AND g.country_code=$10
  ), selected AS (
   SELECT ${metadata}
   FROM horizon h CROSS JOIN library_content c
   JOIN LATERAL (
    SELECT r.* FROM library_content_revisions r
    WHERE r.content_id=c.id AND r.status='approved'
     AND ${visibleApproval}
    ORDER BY r.version DESC LIMIT 1
   ) r ON true
   WHERE ($4::uuid IS NULL OR c.id>$4::uuid) AND ${supported}
    AND ($5::text IS NULL OR r.exercise->>'classification'=$5)
    AND ($6::text IS NULL OR r.exercise->>'type'=$6)
    AND ($7::text IS NULL OR r.category=$7)
    AND ($8::text IS NULL OR CASE WHEN $8='unspecified' THEN NOT(r.curriculum ? 'grade')
      ELSE r.category='Mathematics' AND r.curriculum->>'grade'=$8 END)
    AND ($9::text IS NULL OR r.exercise->>'title' ILIKE $9 OR r.exercise->>'instructions' ILIKE $9)
    AND ($10::text IS NULL OR r.geographic_scope='universal'
     OR (r.geographic_scope='country' AND r.country_code=$10)
     OR (r.geographic_scope='region' AND r.country_code=$10 AND EXISTS(
      SELECT 1 FROM geographic_regions region WHERE region.country_code=$10 AND region.admin1_code=r.admin1_code
       AND region.admin1_code=COALESCE($11::text,(SELECT admin1_code FROM location))))
     OR (r.geographic_scope='city' AND r.country_code=$10 AND r.geographic_id=(SELECT geoname_id FROM location)))
   ORDER BY c.id LIMIT $13
  ) SELECT h.snapshot,COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s."contentId")
   FILTER(WHERE s."contentId" IS NOT NULL),'[]'::jsonb) AS items
   FROM horizon h LEFT JOIN selected s ON true GROUP BY h.snapshot`,
   [cursor?.snapshot??null,supportedMechanics.personal,supportedMechanics.team,cursor?.after??null,
    f.classification??null,f.type??null,f.category??null,f.grade??null,
    f.q===undefined?null:'%'+f.q.replace(/[\\%_]/g,'\\$&')+'%',
    f.countryCode??null,f.admin1Code??null,f.geographicId??null,limit+1]);
  const {snapshot,items} = result.rows[0];
  const more=items.length>limit; items.splice(limit);
  return {items,nextAfter:more?approvedCursor(items.at(-1).contentId,snapshot,f,cursor?.exp):null};
 },
 async detail(id: string, revision: string) {
  const row=(await pool.query(`SELECT ${metadata},r.exercise FROM library_content c
   JOIN library_content_revisions r ON r.content_id=c.id WHERE c.id=$1 AND r.id=$4 AND r.status='approved'
   AND ${supported} AND EXISTS(SELECT 1 FROM library_content_review_events e
    WHERE e.content_id=c.id AND e.revision_id=r.id AND e.decision='approved')`,
   [id,supportedMechanics.personal,supportedMechanics.team,revision])).rows[0];
  if(!row) throw new ContentError('not_found',404);
  return row;
 }
};
