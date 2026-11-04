import { ContentError, uuid } from './contentLibrary.js';
import { personalMechanics, teamMechanics } from './customExerciseSchemas.js';
import { signJwt, verifyJwt } from '../lib/jwt.js';

export const categories = ['Mathematics', 'History', 'Science', 'Mixed'];
export const supportedMechanics = { personal: Object.keys(personalMechanics), team: Object.keys(teamMechanics) };
export interface ApprovedFilters {
 classification?: string; type?: string; category?: string; grade?: string; q?: string;
 countryCode?: string; admin1Code?: string; geographicId?: string;
}
export interface ApprovedPage { limit: number; filters: ApprovedFilters; cursor?: ApprovedCursor }
interface ApprovedCursor { type: 'approved_content_cursor'; after: string; snapshot: string; filters: ApprovedFilters; exp: number }

export function approvedQuery(query: Record<string, unknown>): ApprovedPage {
 const fail = (): never => { throw new ContentError('invalid_discovery_query'); };
 const allowed = ['limit','after','classification','type','category','grade','q','countryCode','admin1Code','geographicId'];
 if (Object.keys(query).some(k => !allowed.includes(k)) || Object.values(query).some(v => typeof v !== 'string')) fail();
 const limit = query.limit === undefined ? 50 : Number(query.limit);
 if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail();
 const filters: ApprovedFilters = {};
 for (const key of allowed.filter(k => !['limit','after'].includes(k))) {
  if (query[key] !== undefined) (filters as Record<string,string>)[key] = query[key] as string;
 }
 const f = filters;
 if (f.classification !== undefined && !['personal','team'].includes(f.classification)) fail();
 if (f.type !== undefined && !(f.classification ? supportedMechanics[f.classification as 'personal'|'team'] : Object.values(supportedMechanics).flat()).includes(f.type)) fail();
 if (f.category !== undefined && !categories.includes(f.category)) fail();
 if (f.grade !== undefined && !['unspecified','5','6','7','8','9','10','11','12'].includes(f.grade)) fail();
 if (f.q !== undefined) { f.q = f.q.trim(); if (!f.q.length || f.q.length > 200) fail(); }
 if (f.countryCode !== undefined && !/^[A-Z]{2}$/.test(f.countryCode)) fail();
 if (f.admin1Code !== undefined && (!f.countryCode || !/^[A-Za-z0-9-]{1,40}$/.test(f.admin1Code))) fail();
 if (f.geographicId !== undefined && (!f.countryCode || !/^[1-9][0-9]{0,17}$/.test(f.geographicId))) fail();
 if (f.admin1Code !== undefined && f.geographicId !== undefined) fail();
 let cursor: ApprovedCursor | undefined;
 if (query.after !== undefined) {
  try {
   if ((query.after as string).length > 12000) fail();
   cursor = verifyJwt<ApprovedCursor>(query.after as string);
   if (cursor.type !== 'approved_content_cursor' || !uuid(cursor.after) || !/^\d+:\d+:[\d,]*$/.test(cursor.snapshot)
    || typeof cursor.exp !== 'number' || JSON.stringify(cursor.filters) !== JSON.stringify(filters)) fail();
  } catch { throw new ContentError('invalid_discovery_cursor'); }
 }
 return { limit, filters, cursor };
}

export function approvedCursor(after: string, snapshot: string, filters: ApprovedFilters, expiresAt?: number) {
 // A separate token type cannot be used as an access token. Expiry bounds MVCC horizon age.
 return signJwt({type:'approved_content_cursor',after,snapshot,filters}, {expiresIn:expiresAt === undefined ? 900 : Math.max(0,expiresAt-Math.floor(Date.now()/1000))});
}
