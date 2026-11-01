import type { QueryConfig } from 'pg';
import { isIP } from 'node:net';
import { pool } from './postgres.js';
export const blocked = (code: string) => ({ status: 'BLOCKED', code });
export async function diagnoseDatabaseBinding(expected: any) {
  if (!expected || Object.keys(expected).sort().join(',') !== 'DEV_PG_SERVER_ADDR,DEV_PG_SERVER_PORT,DEV_PG_SYSTEM_IDENTIFIER'
    || typeof expected.DEV_PG_SYSTEM_IDENTIFIER !== 'string'
    || !/^[1-9][0-9]{0,19}$/.test(expected.DEV_PG_SYSTEM_IDENTIFIER)
    || typeof expected.DEV_PG_SERVER_ADDR !== 'string' || !isIP(expected.DEV_PG_SERVER_ADDR)
    || typeof expected.DEV_PG_SERVER_PORT !== 'string' || !/^[1-9][0-9]{0,4}$/.test(expected.DEV_PG_SERVER_PORT)
    || Number(expected.DEV_PG_SERVER_PORT) > 65535) {
    return blocked('INDEPENDENT_CONFIGURATION_REQUIRED');
  }
  try {
    // One SELECT, one Pool connection and snapshot. No new Pool, writes, grants or process metadata.
    // inet comparison handles equivalent IPv6 spellings; names are fixed by the reviewed DEV contract.
    const query: QueryConfig & { query_timeout: number } = {
      text: `SELECT current_database() = 'tedix_hunt' AS database_match,
        current_user = 'tedix_app' AND session_user = 'tedix_app' AS role_match,
        system_identifier::text = $1 AS cluster_match,
        inet_server_addr() = $2::inet AND inet_server_port() = $3::integer AS endpoint_match
        FROM pg_catalog.pg_control_system()`,
      values: [expected.DEV_PG_SYSTEM_IDENTIFIER, expected.DEV_PG_SERVER_ADDR, expected.DEV_PG_SERVER_PORT],
      query_timeout: 5000,
    };
    const result = await pool.query(query);
    const row = result.rows[0];
    const keys = ['database_match', 'role_match', 'cluster_match', 'endpoint_match'];
    if (result.rows.length !== 1 || keys.some(k => typeof row?.[k] !== 'boolean')) {
      return blocked('IDENTITY_UNAVAILABLE');
    }
    const checks = Object.fromEntries(keys.map(k => [k, row[k] ? 'PASS' : 'FAIL']));
    return { status: keys.every(k => row[k]) ? 'PASS' : 'FAIL', checks };
  } catch (error) {
    // Never pass PostgreSQL errors to the general development error handler or logs.
    const permission = typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
    return blocked(permission ? 'PERMISSION_PG_METADATA' : 'IDENTITY_UNAVAILABLE');
  }
}
