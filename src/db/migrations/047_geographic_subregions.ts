import type { Migration } from './types.js';

// GeoNames admin2 subdivisions (county, district, commune, department...) under an admin1 region.
// Written only by the GeoNames importer from the official admin2Codes.txt dictionary; additive, no backfill.
// Cities keep their existing admin2_code, so a re-import fills this table without touching city IDs or links.
export const geographicSubregionsSql = `
CREATE TABLE geographic_subregions (
 country_code TEXT NOT NULL REFERENCES countries(code),
 admin1_code TEXT NOT NULL CHECK (admin1_code ~ '^[A-Za-z0-9-]{1,40}$' AND admin1_code <> '00'),
 admin2_code TEXT NOT NULL CHECK (admin2_code ~ '^[A-Za-z0-9-]{1,40}$' AND admin2_code <> '00'),
 display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
 source TEXT NOT NULL DEFAULT 'geonames' CHECK (source='geonames'),
 import_id UUID NOT NULL REFERENCES geographic_imports(id),
 PRIMARY KEY(country_code,admin1_code,admin2_code)
);
CREATE INDEX geographic_cities_subregion_idx ON geographic_cities(country_code,admin1_code,admin2_code,geoname_id);
`;
export default {
 id: '047_geographic_subregions',
 async up(client) { await client.query(geographicSubregionsSql); },
} satisfies Migration;
