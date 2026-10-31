import type { Migration } from './types.js';
export const geographicCatalogSql = `
CREATE TABLE geographic_imports (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 source TEXT NOT NULL CHECK(source='geonames'),
 dataset TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 attribution TEXT NOT NULL CHECK(attribution='GeoNames (CC BY 4.0)'),
 imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE geographic_cities (
 geoname_id BIGINT PRIMARY KEY CHECK(geoname_id>0),
 country_code TEXT NOT NULL REFERENCES countries(code),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 administrative_context TEXT NOT NULL CHECK(length(administrative_context) BETWEEN 1 AND 200),
 admin1_code TEXT NOT NULL, admin2_code TEXT NOT NULL,
 latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 population BIGINT NOT NULL CHECK(population>=0),
 source_modified DATE NOT NULL,
 import_id UUID NOT NULL REFERENCES geographic_imports(id),
 locality_id UUID UNIQUE REFERENCES localities(id) ON DELETE RESTRICT,
 reconciled_by UUID, -- immutable actor identifier; no new account-deletion dependency
 reconciliation_reason TEXT,
 reconciled_at TIMESTAMPTZ,
 CHECK((reconciled_by IS NULL AND reconciliation_reason IS NULL AND reconciled_at IS NULL)
  OR (locality_id IS NOT NULL AND reconciled_by IS NOT NULL AND reconciliation_reason IS NOT NULL AND length(btrim(reconciliation_reason)) BETWEEN 1 AND 1000 AND reconciled_at IS NOT NULL)),
 UNIQUE(geoname_id,country_code)
);
CREATE TABLE geographic_city_names (
 geoname_id BIGINT NOT NULL, country_code TEXT NOT NULL,
 normalized_name TEXT COLLATE "C" NOT NULL CHECK(length(normalized_name) BETWEEN 1 AND 300),
 PRIMARY KEY(geoname_id,normalized_name),
 FOREIGN KEY(geoname_id,country_code) REFERENCES geographic_cities(geoname_id,country_code) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX geographic_city_names_prefix_idx ON geographic_city_names(country_code,normalized_name text_pattern_ops,geoname_id);
CREATE INDEX geographic_cities_country_idx ON geographic_cities(country_code,geoname_id);
`;
export default { id: '032_geographic_catalog', async up(client) { await client.query(geographicCatalogSql); } } satisfies Migration;
