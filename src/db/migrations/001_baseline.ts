import type { Migration } from './types.js';

const expectedTables = [
  'users',
  'organizations',
  'organization_members',
  'refresh_tokens',
] as const;

export const baselineMigration: Migration = {
  id: '001_baseline',
  async up(client) {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])`,
      [expectedTables],
    );
    const present = new Set(result.rows.map(({ table_name }) => table_name));
    const missing = expectedTables.filter((table) => !present.has(table));

    // The baseline only records a compatible existing schema; it never creates or changes app tables.
    if (missing.length > 0) {
      throw new Error(
        `Cannot apply baseline: missing expected table(s): ${missing.join(', ')}`,
      );
    }
  },
};

export default baselineMigration;
