import type { Migration } from './types.js';

// Region (admin1) for Localities that are not linked to a GeoNames city, i.e. manual Localities created
// from approved proposals. Linked Localities keep deriving their region from the catalog link.
// Additive and nullable: no backfill, no change to existing Locality identity, snapshots or history.
export const localityRegionSql = `
ALTER TABLE localities ADD COLUMN admin1_code TEXT
  CHECK (admin1_code ~ '^[A-Za-z0-9-]{1,40}$' AND admin1_code NOT IN ('00','unspecified'));
CREATE INDEX localities_region_idx ON localities (country_code, admin1_code);
ALTER TABLE locality_proposals ADD COLUMN admin1_code TEXT
  CHECK (admin1_code ~ '^[A-Za-z0-9-]{1,40}$' AND admin1_code NOT IN ('00','unspecified'));
`;
const migration: Migration = {
  id: '046_locality_regions',
  async up(client) { await client.query(localityRegionSql); },
};
export default migration;
