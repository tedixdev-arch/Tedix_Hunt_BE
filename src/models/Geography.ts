import { pool } from '../lib/postgres.js';

export interface Country { code: string; displayName: string }
export interface Locality {
  id: string;
  countryCode: string;
  countryDisplayName: string;
  name: string;
  administrativeContext: string;
  latitude: number;
  longitude: number;
  active: boolean;
  /** Linked GeoNames city, or null for a manual Locality from an approved proposal. */
  geographicId: string | null;
  /** admin1 region from the linked city, else the manual Locality's region, else `unspecified`. */
  admin1Code: string;
  regionDisplayName: string | null;
}

// Catalog projection deliberately excludes internal source/provider metadata.
// Region comes from the linked GeoNames city when there is one, otherwise from the manual Locality.
const localitySelect = `SELECT l.id, l.country_code AS "countryCode",
  c.display_name AS "countryDisplayName", l.name,
  l.administrative_context AS "administrativeContext", l.latitude, l.longitude, l.active,
  gc.geoname_id::text AS "geographicId",
  COALESCE(NULLIF(NULLIF(gc.admin1_code, ''), '00'), CASE WHEN gc.geoname_id IS NULL THEN l.admin1_code END, 'unspecified') AS "admin1Code",
  gr.display_name AS "regionDisplayName"
  FROM localities l JOIN countries c ON c.code = l.country_code
  LEFT JOIN geographic_cities gc ON gc.locality_id = l.id
  LEFT JOIN geographic_regions gr ON gr.country_code = l.country_code
    AND gr.admin1_code = COALESCE(NULLIF(NULLIF(gc.admin1_code, ''), '00'), CASE WHEN gc.geoname_id IS NULL THEN l.admin1_code END)`;

export const Geography = {
  async countries(): Promise<Country[]> {
    return (await pool.query<Country>('SELECT code, display_name AS "displayName" FROM countries ORDER BY display_name, code')).rows;
  },
  async search(countryCode: string, query: string): Promise<Locality[]> {
    // Escape LIKE metacharacters so user text remains a literal substring.
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    return (await pool.query<Locality>(`${localitySelect}
      WHERE l.country_code = $1 AND l.active AND lower(l.name) LIKE lower($2)
      ORDER BY lower(l.name), l.administrative_context, l.id LIMIT 50`, [countryCode, pattern])).rows;
  },
  async findById(id: string): Promise<Locality | null> {
    return (await pool.query<Locality>(`${localitySelect} WHERE l.id = $1`, [id])).rows[0] ?? null;
  },
};
