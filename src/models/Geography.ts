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
}

// Catalog projection deliberately excludes internal source/provider metadata.
const localitySelect = `SELECT l.id, l.country_code AS "countryCode",
  c.display_name AS "countryDisplayName", l.name,
  l.administrative_context AS "administrativeContext", l.latitude, l.longitude, l.active
  FROM localities l JOIN countries c ON c.code = l.country_code`;

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
