import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { artifactSelect, resolveLocalArtifact } from './OrganizerLocalTemplate.js';

import { normalizeCityName } from '../domain/geographicNames.js';
export { normalizeCityName } from '../domain/geographicNames.js';
export class CatalogError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
const projection = `g.geoname_id::text AS "geographicId",g.country_code AS "countryCode",c.display_name AS "countryDisplayName",
 g.name,g.administrative_context AS "administrativeContext",g.latitude,g.longitude,
 g.locality_id AS "localityId",COALESCE(l.active AND l.country_code=g.country_code,false) AS "registeredActive"`;
const joins = `FROM geographic_cities g JOIN countries c ON c.code=g.country_code LEFT JOIN localities l ON l.id=g.locality_id`;

async function present(rows: any[]) {
  const ids = rows.flatMap(r => r.localityId ? [r.localityId] : []);
  const available = new Set<string>();
  if (ids.length) {
    const artifacts = await pool.query(`${artifactSelect} WHERE t.origin='creator' AND t.category='local' AND v.locality_id=ANY($1::uuid[])`, [ids]);
    for (const row of artifacts.rows) {
      const { artifact } = resolveLocalArtifact(row);
      if (artifact) available.add(`${artifact.localitySnapshot.countryCode}:${artifact.localityId}`);
    }
  }
  return rows.map(row => ({ ...row, source: 'geonames', attribution: 'GeoNames (CC BY 4.0)',
    registrationState: row.localityId ? (row.registeredActive ? 'registered' : 'registered_inactive') : 'registration_required',
    nextAction: row.localityId ? (row.registeredActive ? 'bind_locality' : 'contact_admin') : 'request_registration',
    hasApprovedLocalTemplate: available.has(`${row.countryCode}:${row.localityId}`),
  }));
}

// Canonical mapping never guesses on proximity alone. Same-name candidates block creation.
async function candidates(client: PoolClient, city: any) {
  const identity = (s: string) => normalizeCityName(s).replace(/[^\p{L}\p{N}]/gu,'');
  const names = (await client.query('SELECT normalized_name FROM geographic_city_names WHERE geoname_id=$1', [city.geoname_id])).rows.map(r => identity(r.normalized_name));
  const localities = (await client.query('SELECT * FROM localities WHERE country_code=$1', [city.country_code])).rows;
  return localities.filter(l => names.includes(identity(l.name)) || (l.provider === 'geonames' && l.provider_id === String(city.geoname_id)));
}
function exactMatch(l: any, city: any) {
  return l.country_code === city.country_code && normalizeCityName(l.name) === normalizeCityName(city.name)
    && normalizeCityName(l.administrative_context) === normalizeCityName(city.administrative_context)
    && l.latitude === city.latitude && l.longitude === city.longitude;
}

export const GeographicCatalog = {
  async search(country: string, query: string, limit: number, after: string) {
    const pattern = normalizeCityName(query).replace(/[\\%_]/g, '\\$&') + '%';
    // Ordered source-ID keyset paging is stable across label/population updates. Prefix index filters aliases first.
    const rows = (await pool.query(`WITH matches AS MATERIALIZED (SELECT DISTINCT n.geoname_id FROM geographic_city_names n
        WHERE n.country_code=$1 AND n.normalized_name LIKE $2 AND n.geoname_id>$3::bigint
        ORDER BY n.geoname_id LIMIT $4)
      SELECT ${projection} ${joins} JOIN matches m ON m.geoname_id=g.geoname_id ORDER BY g.geoname_id`, [country,pattern,after,limit+1])).rows;
    const more = rows.length > limit; rows.splice(limit);
    return { cities: await present(rows), nextAfter: more ? rows.at(-1).geographicId : null };
  },
  async get(id: string) {
    const rows = (await pool.query(`SELECT ${projection} ${joins} WHERE g.geoname_id=$1`, [id])).rows;
    if (!rows.length) throw new CatalogError('not_found',404);
    return (await present(rows))[0];
  },
  async resolve(id: string, actorId: string, registration?: { localityId?: string; create?: boolean; reason: string }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const actor = (await client.query('SELECT account_status,is_guest FROM users WHERE id=$1 FOR SHARE',[actorId])).rows[0];
      if (!actor || actor.account_status !== 'active') throw new CatalogError('unauthorized',401);
      const roles = (await client.query('SELECT role FROM user_roles WHERE user_id=$1 FOR SHARE',[actorId])).rows.map(r=>r.role);
      if (actor.is_guest || !roles.some(r=>['creator','admin'].includes(r)) || (registration && !roles.includes('admin'))) throw new CatalogError('forbidden',403);
      // Country -> catalog -> Locality agrees with existing registry writers. Imports take the same country lock.
      const initial = (await client.query('SELECT country_code FROM geographic_cities WHERE geoname_id=$1',[id])).rows[0];
      if (!initial) throw new CatalogError('not_found',404);
      await client.query('SELECT code FROM countries WHERE code=$1 FOR UPDATE',[initial.country_code]);
      const city = (await client.query('SELECT * FROM geographic_cities WHERE geoname_id=$1 FOR UPDATE',[id])).rows[0];
      if (city.country_code !== initial.country_code) throw new CatalogError('catalog_changed');
      if (!city.locality_id) {
        const possible = await candidates(client,city);
        let locality: any;
        if (registration?.localityId) {
          locality = (await client.query('SELECT * FROM localities WHERE id=$1 FOR SHARE',[registration.localityId])).rows[0];
          if (!locality || locality.country_code !== city.country_code) throw new CatalogError('country_locality_mismatch');
          // Explicit Admin reconciliation may confirm a descriptive/coordinate difference; never updates that locality.
        } else if (registration?.create) {
          if (possible.length) throw new CatalogError('reconciliation_required');
          locality = (await client.query(`INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provider,provider_id,provenance)
            VALUES($1,$2,$3,$4,$5,'geonames',$6,$7) RETURNING *`, [city.country_code,city.name,city.administrative_context,city.latitude,city.longitude,id,
            `GeoNames (CC BY 4.0); https://www.geonames.org/${id}; import ${city.import_id}; Admin ${actorId}: ${registration.reason}`])).rows[0];
        } else if (possible.length === 1 && exactMatch(possible[0],city)) locality = possible[0];
        else {
          await client.query('COMMIT');
          return { geographicId: id, localityId: null, registrationState: possible.length ? 'reconciliation_required' : 'registration_required',
            nextAction: possible.length ? 'contact_admin' : 'request_registration' };
        }
        if ((await client.query('SELECT 1 FROM geographic_cities WHERE locality_id=$1 AND geoname_id<>$2',[locality.id,id])).rowCount) throw new CatalogError('reconciliation_required');
        await client.query(`UPDATE geographic_cities SET locality_id=$2,reconciled_by=$3,reconciliation_reason=$4,reconciled_at=CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END WHERE geoname_id=$1`,
          [id,locality.id,registration ? actorId : null,registration?.reason ?? null]);
        if (!registration) await client.query('UPDATE geographic_cities SET reconciled_at=NULL WHERE geoname_id=$1',[id]);
      } else if (registration && (!registration.localityId || registration.localityId.toLowerCase() !== city.locality_id)) throw new CatalogError('already_registered');
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return this.get(id);
  },
};
