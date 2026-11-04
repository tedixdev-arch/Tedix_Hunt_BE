import { randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { ContentError, uuid, validateContentSubmission } from '../domain/contentLibrary.js';
import { approvedQuery, categories } from '../domain/approvedContent.js';

type ObjectValue = Record<string, any>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
const slots = ['personal', 'team'] as const;
export class AllocationError extends ContentError {}
const fail = (code: string, path: string, message: string): never => {
  throw new AllocationError(code, 400, [{ path, message }]);
};
const payload = (e: ObjectValue) => { const { id, owner, ...data } = e; return data; };
export const hasLibraryAllocations = (input: unknown): boolean => object(input) && Array.isArray(input.checkpoints)
  && input.checkpoints.some((cp: unknown) => object(cp) && Object.hasOwn(cp, 'libraryAllocations'));

/** One statement fixes approval visibility, exact payloads and catalog hierarchy for the whole save.
 * Approved revisions/events are immutable; a later draft/approval cannot change these values.
 * Called only inside the existing immutable version INSERT transaction, after locality binding.
 */
export async function allocateLibraryContent(client: PoolClient, input: unknown, category: string | null,
  localityId: string | null, previous?: unknown): Promise<unknown> {
  if (!hasLibraryAllocations(input)) return input;
  // Template shape has already been checked by the existing authoring validator.
  const original = input as ObjectValue;
  const result = structuredClone(original), assignments: ObjectValue[] = [], numbers = new Set<number>();
  if (!category) fail('allocation_requires_classified_template', 'content', 'Use an existing Universal or Local Template. Legacy content is unchanged.');
  const config = result.configuration;
  if (!object(config) || !categories.includes(config.category))
    fail('allocation_category_required', 'content.configuration.category', 'Supply the supported academic category on the Template.');
  if (config.curriculum === 'math' && config.category !== 'Mathematics')
    fail('allocation_category_mismatch', 'content.configuration', 'Math curriculum requires Mathematics category.');
  const grade = config.grade === undefined || config.grade === 'mixed' ? undefined : config.grade;
  if (grade !== undefined && config.category !== 'Mathematics')
    fail('allocation_grade_mismatch', 'content.configuration.grade', 'A specific grade requires Mathematics.');
  if (result.checkpoints.length > 21) fail('invalid_checkpoint_assignment', 'content.checkpoints', 'At most 20 normal checkpoints plus FinishPoint.');
  let terminal = false;
  result.checkpoints.forEach((cp: ObjectValue, index: number) => {
    const path = `content.checkpoints[${index}]`;
    if (cp.role === 'terminal') {
      if (terminal || cp.checkpoint !== undefined || cp.checkpointNumber !== undefined)
        fail('invalid_checkpoint_assignment', path, 'FinishPoint uses the existing unnumbered terminal entry.');
      terminal = true;
    } else {
      if (!Number.isInteger(cp.checkpoint) || cp.checkpoint < 1 || cp.checkpoint > (config.normalCheckpointCount ?? 20)
        || numbers.has(cp.checkpoint) || (cp.checkpointNumber !== undefined && cp.checkpointNumber !== cp.checkpoint))
        fail('invalid_checkpoint_assignment', path, 'Use a unique checkpoint number within the configured range.');
      numbers.add(cp.checkpoint);
    }
    if (!Object.hasOwn(cp, 'libraryAllocations')) return;
    const selections = cp.libraryAllocations;
    if (!object(selections) || !Object.keys(selections).length || Object.keys(selections).some(k => !slots.includes(k as any)))
      fail('invalid_allocation', path, 'Expected personal and/or team allocation.');
    for (const slot of slots) {
      if (!Object.hasOwn(selections, slot)) continue;
      const a = selections[slot], p = `${path}.libraryAllocations.${slot}`;
      if (!object(a) || !['specific', 'random'].includes(a.mode)
        || Object.keys(a).some(k => !['mode', 'contentId', 'revisionId', 'version', 'classification', 'type', 'filters'].includes(k)))
        fail('invalid_allocation', p, 'Use specific with exact IDs, or random with supported filters.');
      const pinned = a.contentId !== undefined || a.revisionId !== undefined;
      if (!pinned && ['version','classification','type'].some(k => Object.hasOwn(a, k)))
        fail('invalid_allocation', p, 'New Random requests accept pool filters only; source metadata is returned after resolution.');
      if ((a.mode === 'specific' || pinned) && (!uuid(a.contentId) || !uuid(a.revisionId)))
        fail('incorrect_revision_identity', p, 'Both Content ID and Revision ID must be UUIDs.');
      if (a.mode === 'specific' && a.filters !== undefined) fail('invalid_allocation', p, 'Specific uses exact IDs, without pool filters.');
      let filters: ObjectValue = {};
      if (a.filters !== undefined) {
        if (!object(a.filters) || Object.keys(a.filters).some(k => !['classification','type','category','grade'].includes(k)))
          fail('invalid_allocation_filters', p, 'Location comes from the Template locality; supported pool filters are classification, type, category and grade.');
        try { filters = approvedQuery(a.filters).filters; }
        catch { fail('invalid_allocation_filters', p, 'Use canonical Content discovery filter values.'); }
      }
      if (filters.classification !== undefined && filters.classification !== slot)
        fail('allocation_classification_mismatch', p, 'Classification must match the challenge slot.');
      if (filters.category !== undefined && filters.category !== config.category)
        fail('allocation_category_mismatch', p, 'Pool category must agree with the Template category.');
      if (grade !== undefined && filters.grade !== undefined && filters.grade !== grade)
        fail('allocation_grade_mismatch', p, 'Pool grade must agree with the Template grade.');
      const oldCp = object(previous) && Array.isArray(previous.checkpoints) ? previous.checkpoints.find((c: ObjectValue) =>
        cp.role === 'terminal' ? c.role === 'terminal' : c.role !== 'terminal' && c.checkpoint === cp.checkpoint) : undefined;
      if (a.mode === 'random' && pinned && !isDeepStrictEqual(a, oldCp?.libraryAllocations?.[slot]))
        fail('invalid_allocation', p, 'Resolved Random IDs may only echo the latest saved assignment in the same slot. Omit IDs to request a new allocation.');
      if (cp.customExercises?.[slot] && (!pinned || !isDeepStrictEqual(a, oldCp?.libraryAllocations?.[slot])))
        fail('allocation_slot_conflict', p, 'Remove the Create Your Own exercise before allocating Library content to this slot.');
      assignments.push({ cp, slot, a, filters, pinned, path: p });
    }
  });
  const ids = assignments.filter(a => a.pinned).map(a => a.a.revisionId);
  // Restrict random candidates by authoritative category/grade before returning payloads.
  // Exact selections are also returned when invalid so errors distinguish identity/approval/eligibility.
  const rows = (await client.query(`WITH location AS MATERIALIZED (
    SELECT l.country_code,g.geoname_id,g.admin1_code,
      EXISTS(SELECT 1 FROM geographic_regions rg WHERE rg.country_code=g.country_code AND rg.admin1_code=g.admin1_code) AS region_known
    FROM localities l LEFT JOIN geographic_cities g ON g.locality_id=l.id AND g.country_code=l.country_code
    WHERE l.id=$3
  ), approved AS MATERIALIZED (
    SELECT r.*, EXISTS(SELECT 1 FROM library_content_review_events e WHERE e.content_id=r.content_id
      AND e.revision_id=r.id AND e.decision='approved') AS evidence
    FROM library_content_revisions r WHERE r.status='approved'
  ), latest AS (SELECT DISTINCT ON(content_id) * FROM approved WHERE evidence ORDER BY content_id,version DESC)
  SELECT r.*, (SELECT row_to_json(l) FROM location l) AS location,
    EXISTS(SELECT 1 FROM latest a WHERE a.id=r.id) AS latest_approved,
    EXISTS(SELECT 1 FROM library_content_review_events e WHERE e.content_id=r.content_id AND e.revision_id=r.id AND e.decision='approved') AS evidence
  FROM library_content_revisions r WHERE r.id=ANY($4::uuid[]) OR ($5::boolean AND r.id IN(SELECT id FROM latest)
    AND r.category=$1 AND ($2::text IS NULL OR r.curriculum->>'grade'=$2)) ORDER BY r.content_id,r.version`,
  [config.category, grade ?? null, category === 'local' ? localityId : null, ids, assignments.some(s => !s.pinned)])).rows;
  const eligibility = (r: ObjectValue, s: ObjectValue): string | null => {
    if (r.status !== 'approved' || !r.evidence) return 'unapproved_revision';
    if (r.exercise.classification !== s.slot) return 'allocation_classification_mismatch';
    if (r.category !== config.category || (s.filters.category && r.category !== s.filters.category)) return 'allocation_category_mismatch';
    if ((grade !== undefined && r.curriculum.grade !== grade)
      || (s.filters.grade === 'unspecified' ? r.curriculum.grade !== undefined : s.filters.grade !== undefined && r.curriculum.grade !== s.filters.grade)) return 'allocation_grade_mismatch';
    const l = r.location;
    if (r.geographic_scope !== 'universal' && (!l || r.country_code !== l.country_code
      || (r.geographic_scope === 'region' && (!l.region_known || r.admin1_code !== l.admin1_code))
      || (r.geographic_scope === 'city' && String(r.geographic_id) !== String(l.geoname_id)))) return 'allocation_geography_mismatch';
    if (s.filters.type && r.exercise.type !== s.filters.type) return 'allocation_mechanic_mismatch';
    try { validateContentSubmission({exercise:r.exercise,category:r.category,curriculum:r.curriculum,
      geography: r.geographic_scope === 'universal' ? {scope:'universal'} : r.geographic_scope === 'country'
        ? {scope:'country',countryCode:r.country_code} : r.geographic_scope === 'region'
          ? {scope:'region',countryCode:r.country_code,admin1Code:r.admin1_code}
          : {scope:'city',countryCode:r.country_code,geographicId:String(r.geographic_id)}}); }
    catch { return 'unsupported_content_revision'; }
    return null;
  };
  const used = new Set<string>();
  for (const s of assignments.filter(s => s.pinned)) {
    const row = rows.find(r => r.id === s.a.revisionId.toLowerCase() && r.content_id === s.a.contentId.toLowerCase());
    if (!row) fail('incorrect_revision_identity', s.path, 'The exact Content/Revision pair does not exist.');
    if ((s.a.version !== undefined && s.a.version !== row.version)
      || (s.a.classification !== undefined && s.a.classification !== row.exercise.classification)
      || (s.a.type !== undefined && s.a.type !== row.exercise.type))
      fail('incorrect_revision_identity', s.path, 'Supplied revision metadata must match the exact approved source.');
    const error = eligibility(row, s);
    if (error) fail(error, s.path, 'Choose an approved revision matching this Template and checkpoint classification.');
    if (s.slot === 'personal' && used.has(row.content_id)) fail('duplicate_personal_exercise', s.path, 'A Personal Content identity may occur only once across all checkpoints, including FinishPoint.');
    if (s.slot === 'personal') used.add(row.content_id);
    s.selected = row;
  }
  const pending = assignments.filter(s => !s.pinned);
  for (const s of pending) {
    s.pool = rows.filter(r => r.latest_approved && !eligibility(r, s) && (s.slot !== 'personal' || !used.has(r.content_id)));
    if (!s.pool.length) fail(rows.some(r => r.latest_approved && !eligibility(r, s)) ? 'insufficient_distinct_exercises' : 'empty_random_pool', s.path,
      'Add more eligible approved exercises or broaden the pool filters.');
    for (let i = s.pool.length - 1; i > 0; i--) { const j = randomInt(i + 1); [s.pool[i], s.pool[j]] = [s.pool[j], s.pool[i]]; }
  }
  // Augmenting paths avoid greedy false failures when constrained pools overlap.
  const owners = new Map<string, ObjectValue>();
  const match = (s: ObjectValue, visited: Set<string>): boolean => {
    for (const row of s.pool) {
      if (visited.has(row.content_id)) continue;
      visited.add(row.content_id);
      const old = owners.get(row.content_id);
      if (!old || match(old, visited)) { owners.set(row.content_id, s); s.selected = row; return true; }
    }
    return false;
  };
  for (const s of pending) {
    if (s.slot === 'team') s.selected = s.pool[0];
    else if (!match(s, new Set())) fail('insufficient_distinct_exercises', s.path, 'The approved pools cannot supply distinct Personal exercises for all checkpoints.');
  }
  for (const s of assignments) {
    const r = s.selected;
    if (s.cp.customExercises?.[s.slot] && !isDeepStrictEqual(payload(s.cp.customExercises[s.slot]), r.exercise))
      fail('allocated_payload_mismatch', s.path, 'Library payloads are immutable. Remove the allocation explicitly before authoring your own exercise.');
    s.cp.customExercises ??= {};
    s.cp.customExercises[s.slot] = structuredClone(r.exercise);
    s.cp.libraryAllocations[s.slot] = { mode:s.a.mode, contentId:r.content_id, revisionId:r.id,
      version:r.version, classification:s.slot, type:r.exercise.type, ...(s.a.filters ? {filters:s.a.filters} : {}) };
  }
  return result;
}
