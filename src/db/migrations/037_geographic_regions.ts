import type { Migration } from './types.js';

export const geographicRegionsSql = `
CREATE TABLE geographic_regions (
 country_code TEXT NOT NULL REFERENCES countries(code),
 admin1_code TEXT NOT NULL CHECK (admin1_code ~ '^[A-Za-z0-9-]{1,40}$' AND admin1_code <> '00'),
 display_name TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
 source TEXT NOT NULL DEFAULT 'geonames' CHECK (source='geonames'),
 import_id UUID NOT NULL REFERENCES geographic_imports(id),
 PRIMARY KEY(country_code,admin1_code)
);
CREATE INDEX geographic_cities_region_idx ON geographic_cities(country_code,admin1_code,geoname_id);
`;
export default {
 id: '037_geographic_regions',
 async up(client) { await client.query(geographicRegionsSql); },
} satisfies Migration;
