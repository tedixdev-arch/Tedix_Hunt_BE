import { pool } from '../lib/postgres.js';

export interface CatalogCity {
  countryCode: string; countryDisplayName: string;
  /** Catalog cities have a GeoNames ID; manual Localities from approved proposals have null. */
  geographicId: string | null;
  localityId: string | null; name: string; administrativeContext: string; regionCode: string | null; regionDisplayName: string | null;
  registeredActive?: boolean; source?: 'geonames' | 'registry';
}

// Same stored geographic catalog as Creator discovery. Approval affects Hunt inventory only.
export async function catalogCities(countryCode: string): Promise<CatalogCity[]> {
  return (await pool.query<CatalogCity>(`SELECT g.geoname_id::text AS "geographicId",
    g.country_code AS "countryCode",c.display_name AS "countryDisplayName",
    l.id AS "localityId",g.name,g.administrative_context AS "administrativeContext",
    CASE WHEN g.admin1_code IN ('','00') THEN NULL ELSE g.admin1_code END AS "regionCode",
    r.display_name AS "regionDisplayName",COALESCE(l.active,false) AS "registeredActive",NULL::text AS "source"
    FROM geographic_cities g JOIN countries c ON c.code=g.country_code
    LEFT JOIN localities l ON l.id=g.locality_id AND l.country_code=g.country_code
    LEFT JOIN geographic_regions r ON r.country_code=g.country_code AND r.admin1_code=g.admin1_code
    WHERE g.country_code=$1
    UNION ALL
    -- Manual Localities (approved proposals) are not GeoNames cities but are usable places in their region.
    SELECT NULL,l.country_code,c.display_name,l.id,l.name,l.administrative_context,l.admin1_code,
      r.display_name,l.active,'registry'
    FROM localities l JOIN countries c ON c.code=l.country_code
    LEFT JOIN geographic_regions r ON r.country_code=l.country_code AND r.admin1_code=l.admin1_code
    WHERE l.country_code=$1 AND l.active AND NOT EXISTS(SELECT 1 FROM geographic_cities g WHERE g.locality_id=l.id)`, [countryCode])).rows;
}

export async function catalogRegions(countryCode: string): Promise<Pick<CatalogCity,'countryCode'|'regionCode'|'regionDisplayName'>[]> {
  return (await pool.query(`WITH codes AS (
    SELECT country_code,admin1_code FROM geographic_regions WHERE country_code=$1
    UNION SELECT country_code,admin1_code FROM geographic_cities WHERE country_code=$1
    UNION SELECT l.country_code,COALESCE(l.admin1_code,'') FROM localities l
      WHERE l.country_code=$1 AND l.active AND NOT EXISTS(SELECT 1 FROM geographic_cities g WHERE g.locality_id=l.id)
  ) SELECT DISTINCT codes.country_code AS "countryCode",
    CASE WHEN codes.admin1_code IN ('','00') THEN NULL ELSE codes.admin1_code END AS "regionCode",
    r.display_name AS "regionDisplayName"
    FROM codes LEFT JOIN geographic_regions r ON r.country_code=codes.country_code AND r.admin1_code=codes.admin1_code`, [countryCode])).rows;
}
