import type { Migration } from './types.js';

const migration: Migration = {
  id: '026_template_locality_binding',
  async up(client) {
    await client.query(`
-- Binding is version metadata. Existing rows remain an unbound NULL pair.
ALTER TABLE hunt_template_versions
  ADD COLUMN locality_id UUID REFERENCES localities(id) ON DELETE RESTRICT,
  ADD COLUMN locality_snapshot JSONB,
  ADD CONSTRAINT hunt_template_versions_locality_pair_check CHECK (
    (locality_id IS NULL AND locality_snapshot IS NULL) OR
    (locality_id IS NOT NULL AND locality_snapshot IS NOT NULL AND category IS NOT NULL AND category = 'local')
  ),
  ADD CONSTRAINT hunt_template_versions_locality_snapshot_check CHECK (
    locality_snapshot IS NULL OR COALESCE((
      jsonb_typeof(locality_snapshot) = 'object'
      AND locality_snapshot ?& ARRAY['id','countryCode','countryDisplayName','name','administrativeContext','latitude','longitude']
      AND locality_snapshot - ARRAY['id','countryCode','countryDisplayName','name','administrativeContext','latitude','longitude'] = '{}'::jsonb
      AND jsonb_typeof(locality_snapshot->'id') = 'string'
      AND locality_snapshot->>'id' = locality_id::text
      AND jsonb_typeof(locality_snapshot->'countryCode') = 'string'
      AND locality_snapshot->>'countryCode' ~ '^[A-Z]{2}$'
      AND jsonb_typeof(locality_snapshot->'countryDisplayName') = 'string'
      AND length(locality_snapshot->>'countryDisplayName') BETWEEN 1 AND 100
      AND btrim(locality_snapshot->>'countryDisplayName') <> ''
      AND jsonb_typeof(locality_snapshot->'name') = 'string'
      AND length(locality_snapshot->>'name') BETWEEN 1 AND 200
      AND btrim(locality_snapshot->>'name') <> ''
      AND jsonb_typeof(locality_snapshot->'administrativeContext') = 'string'
      AND length(locality_snapshot->>'administrativeContext') BETWEEN 1 AND 200
      AND btrim(locality_snapshot->>'administrativeContext') <> ''
      AND CASE WHEN jsonb_typeof(locality_snapshot->'latitude') = 'number'
        THEN (locality_snapshot->>'latitude')::numeric BETWEEN -90 AND 90 ELSE FALSE END
      AND CASE WHEN jsonb_typeof(locality_snapshot->'longitude') = 'number'
        THEN (locality_snapshot->>'longitude')::numeric BETWEEN -180 AND 180 ELSE FALSE END
    ), FALSE)
  );
-- The existing identity-binding trigger rejects every classified UPDATE, even drafts.
-- Its owner/category checks and existing protected/unused-draft deletion rules are retained.
    `);
  },
};

export default migration;
