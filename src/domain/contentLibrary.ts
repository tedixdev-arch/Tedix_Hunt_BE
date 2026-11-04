import { validateCustomExercises, type ExerciseIssue } from './customExercises.js';
export class ContentError extends Error {
  constructor(public code: string, public status = 400, public details?: ExerciseIssue[]) { super(code); }
}
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validateContent(input: unknown) {
  const fail = (message: string): never => { throw new ContentError('invalid_content',400,[{path:'content',message}]); };
  if (!record(input) || Object.keys(input).some(k => !['exercise','category','curriculum','geography','baseRevisionId'].includes(k))) return fail('Unsupported content envelope');
  const e = input.exercise;
  if (!record(e) || !['personal','team'].includes(e.classification) || 'id' in e || 'owner' in e) return fail('Exercise must omit Template identity and use personal or team classification');
  const details = validateCustomExercises({checkpoints:[{checkpoint:1,customExercises:{[e.classification]:e}}]});
  if (details.length) throw new ContentError('invalid_content',400,details);
  const category = input.category ?? null;
  if (category !== null && !['Mathematics','History','Science','Mixed'].includes(category)) return fail('Invalid category');
  const curriculum = input.curriculum ?? {};
  if (!record(curriculum) || Object.keys(curriculum).some(k => !['subject','grade'].includes(k))
    || (curriculum.subject !== undefined && curriculum.subject !== 'math')
    || (curriculum.grade !== undefined && !['5','6','7','8','9','10','11','12'].includes(curriculum.grade))) return fail('Unsupported curriculum identifier; Main/Unit/Lesson catalog pending');
  const geography = input.geography ?? {scope:'universal'};
  if (!record(geography)) return fail('Invalid geography');
  const fields: Record<string,string[]> = {universal:['scope'],country:['scope','countryCode'],region:['scope','countryCode','admin1Code'],city:['scope','countryCode','geographicId']};
  const keys = fields[geography.scope];
  if (!keys || Object.keys(geography).length !== keys.length || keys.some(k => !Object.hasOwn(geography,k))) return fail('Invalid geography fields');
  if (geography.scope !== 'universal' && (typeof geography.countryCode !== 'string' || !/^[A-Z]{2}$/.test(geography.countryCode))) return fail('Invalid country code');
  if (geography.scope === 'region' && (typeof geography.admin1Code !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(geography.admin1Code))) return fail('Invalid region identifier');
  if (geography.scope === 'city' && (typeof geography.geographicId !== 'string' || !/^[1-9][0-9]{0,17}$/.test(geography.geographicId))) return fail('Invalid GeoNames identifier');
  return {exercise:e,category,curriculum,geography};
}

// C2a permits a missing category in drafts. Submission requires a supported category,
// but no math curriculum (or invented Main/Unit/Lesson identifiers) is required.
export function validateContentSubmission(input: unknown) {
  const data = validateContent(input);
  if (data.category === null) throw new ContentError('submission_category_required');
  return data;
}
export function reviewComment(input: unknown, required: boolean): string | null {
  if (input === undefined && !required) return null;
  if (typeof input !== 'string' || input.trim().length < 3 || input.trim().length > 1000 || !/[\p{L}\p{N}]/u.test(input)) {
    throw new ContentError('invalid_review_comment');
  }
  return input.trim();
}
