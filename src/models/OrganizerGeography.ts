import { pool } from '../lib/postgres.js';
import { artifactSelect, resolveLocalArtifact } from './OrganizerLocalTemplate.js';

export interface EligibleCity {
  geographicId: string; countryCode: string; countryDisplayName: string;
  localityId: string; name: string; administrativeContext: string; regionCode: string | null; regionDisplayName: string | null;
}

// One statement snapshot. No SQL LIMIT: C7 validation must precede grouping and paging.
export async function eligibleCities(countryCode?: string): Promise<EligibleCity[]> {
  const { rows } = await pool.query(`SELECT a.*,g.geoname_id::text AS "geographicId",
    CASE WHEN g.admin1_code IN ('','00') THEN NULL ELSE g.admin1_code END AS "regionCode",g.administrative_context AS "catalogContext",g.name AS "catalogName",r.display_name AS "regionDisplayName"
    FROM (${artifactSelect} WHERE t.origin='creator' AND t.category='local') a
    JOIN geographic_cities g ON g.locality_id=a."localityId"
      AND g.country_code=(a."currentLocality"->>'countryCode')
    LEFT JOIN geographic_regions r ON r.country_code=g.country_code AND r.admin1_code=g.admin1_code
    WHERE ($1::text IS NULL OR g.country_code=$1)`,[countryCode ?? null]);
  const cities = new Map<string,EligibleCity>();
  for (const row of rows) {
    const { artifact } = resolveLocalArtifact(row);
    if (!artifact) continue;
    const l = artifact.currentLocality;
    cities.set(row.geographicId,{geographicId:row.geographicId,countryCode:l.countryCode,
      countryDisplayName:l.countryDisplayName,localityId:l.id,name:row.catalogName,
      administrativeContext:row.catalogContext,regionCode:row.regionCode,regionDisplayName:row.regionDisplayName ?? null});
  }
  return [...cities.values()];
}
