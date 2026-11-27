import type { PoolClient } from 'pg';
import { pool } from '../lib/postgres.js';
import { artifactSelect, resolveLocalArtifact } from './OrganizerLocalTemplate.js';

import { normalizeCityName } from '../domain/geographicNames.js';
import { UNSPECIFIED_REGION, UNSPECIFIED_SUBREGION, UNSPECIFIED_SUBREGION_LABEL, isAdmin1Code, placeIdentity, regionDisplayName, regionLabel, subregionLabel } from '../domain/geographicRegions.js';
export { normalizeCityName } from '../domain/geographicNames.js';
export class CatalogError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
const projection = `g.geoname_id::text AS "geographicId",g.country_code AS "countryCode",c.display_name AS "countryDisplayName",
 g.admin1_code AS "admin1Code",r.display_name AS "regionDisplayName",
 CASE WHEN g.admin1_code IN ('','00') THEN 'unspecified' WHEN r.admin1_code IS NULL THEN 'missing_label' ELSE 'resolved' END AS "regionStatus",
 CASE WHEN s.admin2_code IS NULL THEN '${UNSPECIFIED_SUBREGION}' ELSE s.admin2_code END AS "admin2Code",s.display_name AS "subregionDisplayName",
 g.name,g.administrative_context AS "administrativeContext",g.latitude,g.longitude,
 g.locality_id AS "localityId",COALESCE(l.active AND l.country_code=g.country_code,false) AS "registeredActive"`;
const joins = `FROM geographic_cities g JOIN countries c ON c.code=g.country_code LEFT JOIN localities l ON l.id=g.locality_id LEFT JOIN geographic_regions r ON r.country_code=g.country_code AND r.admin1_code=g.admin1_code
 LEFT JOIN geographic_subregions s ON s.country_code=g.country_code AND s.admin1_code=g.admin1_code AND s.admin2_code=g.admin2_code`;
// A city belongs to the unspecified subregion group when no official subdivision record matches it.
const noSubregion = (alias: string) => `NOT EXISTS(SELECT 1 FROM geographic_subregions sx
 WHERE sx.country_code=${alias}.country_code AND sx.admin1_code=${alias}.admin1_code AND sx.admin2_code=${alias}.admin2_code)`;

// Completion and catalog rows must both be committed before reads can claim availability.
async function catalogReady(db: Pick<PoolClient, 'query'> = pool): Promise<boolean> {
  return (await db.query(`SELECT EXISTS(
    SELECT 1 FROM geographic_imports i WHERE i.completed_at IS NOT NULL AND i.row_count>0
    AND EXISTS(SELECT 1 FROM geographic_cities g JOIN geographic_city_names n USING(geoname_id)
      WHERE g.import_id=i.id)
  ) AS ready`)).rows[0].ready;
}
async function requireCatalogReady(db: Pick<PoolClient, 'query'> = pool) {
  if (!await catalogReady(db)) throw new CatalogError('catalog_not_imported',503);
}

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
  return rows.map(row => ({ ...row, source: row.source ?? 'geonames', attribution: row.source === 'registry' ? null : 'GeoNames (CC BY 4.0)',
    // Any catalog city can be used: an unlinked city gets its Locality automatically when it is first selected (resolve).
    registrationState: row.localityId ? (row.registeredActive ? 'registered' : 'registered_inactive') : 'not_linked',
    nextAction: row.localityId ? (row.registeredActive ? 'bind_locality' : 'unavailable') : 'resolve_city',
    hasApprovedLocalTemplate: available.has(`${row.countryCode}:${row.localityId}`),
  }));
}

// Canonical mapping never guesses on proximity alone. Same-name candidates block creation.
async function candidates(client: PoolClient, city: any) {
  const identity = (s: string) => placeIdentity(normalizeCityName(s));
  const names = (await client.query('SELECT normalized_name FROM geographic_city_names WHERE geoname_id=$1', [city.geoname_id])).rows.map(r => identity(r.normalized_name));
  const localities = (await client.query('SELECT * FROM localities WHERE country_code=$1', [city.country_code])).rows;
  return localities.filter(l => names.includes(identity(l.name)) || (l.provider === 'geonames' && l.provider_id === String(city.geoname_id)));
}
function exactMatch(l: any, city: any) {
  return l.country_code === city.country_code && normalizeCityName(l.name) === normalizeCityName(city.name)
    && normalizeCityName(l.administrative_context) === normalizeCityName(city.administrative_context)
    && l.latitude === city.latitude && l.longitude === city.longitude;
}

// Manual Localities (approved proposals) are not GeoNames cities; they appear beside catalog cities in their region.
async function registryLocalities(country: string, normalizedQuery: string | null, admin1Code?: string) {
  const rows = (await pool.query(`SELECT NULL::text AS "geographicId",l.country_code AS "countryCode",c.display_name AS "countryDisplayName",
      COALESCE(l.admin1_code,'${UNSPECIFIED_REGION}') AS "admin1Code",r.display_name AS "regionDisplayName",
      CASE WHEN l.admin1_code IS NULL THEN 'unspecified' WHEN r.admin1_code IS NULL THEN 'missing_label' ELSE 'resolved' END AS "regionStatus",
      '${UNSPECIFIED_SUBREGION}' AS "admin2Code",NULL::text AS "subregionDisplayName",
      l.name,l.administrative_context AS "administrativeContext",l.latitude,l.longitude,l.id AS "localityId",l.active AS "registeredActive",
      'registry' AS source
    FROM localities l JOIN countries c ON c.code=l.country_code
    LEFT JOIN geographic_regions r ON r.country_code=l.country_code AND r.admin1_code=l.admin1_code
    WHERE l.country_code=$1 AND NOT EXISTS(SELECT 1 FROM geographic_cities g WHERE g.locality_id=l.id)
      AND ($2::text IS NULL OR ($2='${UNSPECIFIED_REGION}' AND l.admin1_code IS NULL) OR l.admin1_code=$2)
    ORDER BY lower(l.name),l.id LIMIT 500`, [country, admin1Code ?? null])).rows;
  return normalizedQuery === null ? rows : rows.filter(row => normalizeCityName(row.name).startsWith(normalizedQuery));
}

export const GeographicCatalog = {
  async status() {
    const ready = await catalogReady();
    return {source:'geonames',status:ready ? 'ready' : 'not_imported',nextAction:ready ? null : 'import_catalog'};
  },
  async regions(country: string, limit: number, after: string) {
    await requireCatalogReady();
    // One region list per country: official admin1 regions, admin1 codes used by cities without an official
    // label (shown by code), and one explicit "unspecified" group for cities and manual Localities without admin1.
    const rows=(await pool.query(`WITH codes AS (
        SELECT admin1_code FROM geographic_regions WHERE country_code=$1
        UNION SELECT CASE WHEN admin1_code IN ('','00') THEN '${UNSPECIFIED_REGION}' ELSE admin1_code END
          FROM geographic_cities WHERE country_code=$1
        UNION SELECT COALESCE(l.admin1_code,'${UNSPECIFIED_REGION}') FROM localities l
          WHERE l.country_code=$1 AND NOT EXISTS(SELECT 1 FROM geographic_cities g WHERE g.locality_id=l.id))
      SELECT $1::text AS "countryCode",codes.admin1_code AS "admin1Code",r.display_name AS "displayName",
        'geonames' AS source,'GeoNames (CC BY 4.0)' AS attribution
      FROM codes LEFT JOIN geographic_regions r ON r.country_code=$1 AND r.admin1_code=codes.admin1_code
      WHERE codes.admin1_code COLLATE "C">$2 COLLATE "C" ORDER BY codes.admin1_code COLLATE "C" LIMIT $3`,[country,after,limit+1])).rows;
    const missing=(await pool.query(`SELECT EXISTS(SELECT 1 FROM geographic_cities g LEFT JOIN geographic_regions r
      ON r.country_code=g.country_code AND r.admin1_code=g.admin1_code
      WHERE g.country_code=$1 AND g.admin1_code NOT IN ('','00') AND r.admin1_code IS NULL) AS missing`,[country])).rows[0].missing;
    const more=rows.length>limit; rows.splice(limit);
    // labelStatus lets clients that need an official region (Content region scope) skip code-only and unspecified groups.
    return {regions:rows.map(r=>({...r,displayName:regionDisplayName(r.admin1Code,r.displayName),
        labelStatus:r.admin1Code===UNSPECIFIED_REGION?'unspecified':r.displayName===null?'missing_label':'resolved'})),
      nextAfter:more?rows.at(-1).admin1Code:null,regionLabel:regionLabel(country),
      metadataStatus:missing?'incomplete':'ready'};
  },
  /**
   * Official admin2 subdivisions of one region, plus an explicit `unspecified` group when some cities (or manual
   * Localities) of the region match none. Empty when the region has no named subdivisions: clients then skip
   * the level. Never paged: the largest regions have a few hundred subdivisions.
   */
  async subregions(country: string, admin1Code: string) {
    await requireCatalogReady();
    const rows = (await pool.query(`SELECT s.admin2_code AS "admin2Code",s.display_name AS "displayName"
      FROM geographic_subregions s WHERE s.country_code=$1 AND s.admin1_code=$2
      ORDER BY lower(s.display_name),s.admin2_code LIMIT 5000`, [country, admin1Code])).rows;
    const other = rows.length > 0 && (await pool.query(`SELECT EXISTS(SELECT 1 FROM geographic_cities g
        WHERE g.country_code=$1 AND g.admin1_code=$2 AND ${noSubregion('g')})
      OR EXISTS(SELECT 1 FROM localities l WHERE l.country_code=$1 AND l.admin1_code=$2
        AND NOT EXISTS(SELECT 1 FROM geographic_cities g WHERE g.locality_id=l.id)) AS other`, [country, admin1Code])).rows[0].other;
    return {
      subregions: [
        ...rows.map(r => ({ countryCode: country, admin1Code, admin2Code: r.admin2Code, displayName: r.displayName, labelStatus: 'resolved' })),
        ...(other ? [{ countryCode: country, admin1Code, admin2Code: UNSPECIFIED_SUBREGION, displayName: UNSPECIFIED_SUBREGION_LABEL, labelStatus: 'unspecified' }] : []),
      ],
      regionLabel: regionLabel(country), subregionLabel: subregionLabel(country),
    };
  },
  /**
   * City choices for one country. With a query, prefix-matches names and aliases; without a query (region
   * required by the route) lists every city of the region. Pages use stable GeoNames ID order.
   * The first page also returns active and inactive manual Localities (approved proposals that are not
   * GeoNames cities) as `registryLocalities`, in the same shape with a null geographicId.
   */
  async search(country: string, query: string | undefined, limit: number, after: string, admin1Code?: string, admin2Code?: string) {
    await requireCatalogReady();
    // Optional subregion filter (the route requires a concrete region with it): one subdivision, or the cities
    // matching no official subdivision ("unspecified").
    const subregion = admin2Code === UNSPECIFIED_SUBREGION ? `($6::text IS NULL AND ${noSubregion('filtered')})`
      : `($6::text IS NULL OR filtered.admin2_code=$6)`;
    const region = (admin1Code === UNSPECIFIED_REGION ? `(filtered.admin1_code IN ('','00') AND $5::text IS NULL)`
      : `($5::text IS NULL OR filtered.admin1_code=$5)`) + ` AND ${subregion}`;
    const regionParam = admin1Code === UNSPECIFIED_REGION ? null : admin1Code ?? null;
    const normalized = query === undefined ? null : normalizeCityName(query);
    const pattern = normalized === null ? null : normalized.replace(/[\\%_]/g, '\\$&') + '%';
    // Ordered source-ID keyset paging is stable across label/population updates. Prefix index filters aliases first.
    const matches = pattern === null
      ? `SELECT filtered.geoname_id FROM geographic_cities filtered WHERE filtered.country_code=$1 AND ${region}
          AND ($2::text IS NULL) AND filtered.geoname_id>$3::bigint ORDER BY filtered.geoname_id LIMIT $4`
      : `SELECT DISTINCT n.geoname_id FROM geographic_city_names n
          JOIN geographic_cities filtered ON filtered.geoname_id=n.geoname_id
          WHERE n.country_code=$1 AND ${region} AND n.normalized_name LIKE $2 AND n.geoname_id>$3::bigint
          ORDER BY n.geoname_id LIMIT $4`;
    const rows = (await pool.query(`WITH matches AS MATERIALIZED (${matches})
      SELECT ${projection} ${joins} JOIN matches m ON m.geoname_id=g.geoname_id ORDER BY g.geoname_id`,
      [country,pattern,after,limit+1,regionParam,admin2Code === UNSPECIFIED_SUBREGION ? null : admin2Code ?? null])).rows;
    const more = rows.length > limit; rows.splice(limit);
    // Manual Localities have no subdivision: listed for the whole region and in its unspecified group only.
    const registry = after === '0' && (admin2Code === undefined || admin2Code === UNSPECIFIED_SUBREGION)
      ? await registryLocalities(country, normalized, admin1Code) : [];
    return { cities: await present(rows), registryLocalities: await present(registry), nextAfter: more ? rows.at(-1).geographicId : null };
  },
  async get(id: string) {
    await requireCatalogReady();
    const rows = (await pool.query(`SELECT ${projection} ${joins} WHERE g.geoname_id=$1`, [id])).rows;
    if (!rows.length) throw new CatalogError('not_found',404);
    return (await present(rows))[0];
  },
  /**
   * Makes a catalog city usable and returns it with its Locality. No Admin step is involved: an unlinked city is
   * linked to its own GeoNames Locality or to the single exact same-place Locality, otherwise a new Locality is created.
   */
  async resolve(id: string, actorId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const actor = (await client.query('SELECT account_status,is_guest FROM users WHERE id=$1 FOR SHARE',[actorId])).rows[0];
      if (!actor || actor.account_status !== 'active') throw new CatalogError('unauthorized',401);
      const roles = (await client.query('SELECT role FROM user_roles WHERE user_id=$1 FOR SHARE',[actorId])).rows.map(r=>r.role);
      if (actor.is_guest || !roles.some(r=>['creator','admin'].includes(r))) throw new CatalogError('forbidden',403);
      await requireCatalogReady(client);
      // Country -> catalog -> Locality agrees with existing registry writers. Imports take the same country lock,
      // so concurrent selections of one city create at most one Locality.
      const initial = (await client.query('SELECT country_code FROM geographic_cities WHERE geoname_id=$1',[id])).rows[0];
      if (!initial) throw new CatalogError('not_found',404);
      await client.query('SELECT code FROM countries WHERE code=$1 FOR UPDATE',[initial.country_code]);
      const city = (await client.query('SELECT * FROM geographic_cities WHERE geoname_id=$1 FOR UPDATE',[id])).rows[0];
      if (city.country_code !== initial.country_code) throw new CatalogError('catalog_changed');
      if (!city.locality_id) {
        const possible = await candidates(client,city);
        const linked = new Set((await client.query('SELECT locality_id FROM geographic_cities WHERE locality_id = ANY($1::uuid[])',[possible.map(l=>l.id)])).rows.map(r=>r.locality_id));
        const free = possible.filter(l => !linked.has(l.id));
        // Reuse this city's own GeoNames Locality or the one exact same-place Locality; never guess between several.
        let locality = free.find(l => l.provider === 'geonames' && l.provider_id === String(id)) ?? (free.length === 1 && exactMatch(free[0],city) ? free[0] : undefined);
        const created = !locality;
        if (!locality) locality = (await client.query(`INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provider,provider_id,provenance,admin1_code)
            VALUES($1,$2,$3,$4,$5,'geonames',$6,$7,$8) RETURNING *`, [city.country_code,city.name,city.administrative_context,city.latitude,city.longitude,id,
            `GeoNames (CC BY 4.0); https://www.geonames.org/${id}; import ${city.import_id}; created automatically when selected by ${actorId}`,
            isAdmin1Code(city.admin1_code) ? city.admin1_code : null])).rows[0];
        await client.query(`UPDATE geographic_cities SET locality_id=$2,reconciled_by=$3,reconciliation_reason=$4,reconciled_at=CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END WHERE geoname_id=$1`,
          [id,locality.id,created ? actorId : null,created ? 'Locality created automatically when the city was selected' : null]);
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return this.get(id);
  },
};
