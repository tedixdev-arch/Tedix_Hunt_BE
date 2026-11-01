import type { Migration } from './types.js';

export const geographicImportCompletionSql = `
-- An old manifest alone is not evidence of a completed import. No readiness backfill.
ALTER TABLE geographic_imports
 ADD COLUMN completed_at TIMESTAMPTZ,
 ADD COLUMN row_count BIGINT,
 ADD CONSTRAINT geographic_imports_completion_check CHECK (
  (completed_at IS NULL AND row_count IS NULL) OR
  (completed_at IS NOT NULL AND row_count IS NOT NULL AND row_count > 0)
 );
`;
export default {
 id: '033_geographic_import_completion',
 async up(client) { await client.query(geographicImportCompletionSql); },
} satisfies Migration;
