import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

// Only the workflow's disposable service can be used by this test helper.
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '5432');
assert.equal(url.pathname, '/geonames_ci');
assert.equal(decodeURIComponent(url.username), 'geonames_ci');
const client = new Client({ connectionString: url.href });
const sql = readFileSync(process.env.GEONAMES_DIR + '/package/import.sql', 'utf8');
const started = performance.now();
try {
 await client.connect();
 await client.query('SET ROLE geonames_package_app');
 assert.equal((await client.query('SELECT current_user')).rows[0].current_user, 'geonames_package_app');
 await client.query(sql);
 appendFileSync(process.env.GEONAMES_DIR + '/package/execution.md',
  `- PostgreSQL 17 restricted-role execution: ${(performance.now()-started).toFixed(0)} ms; ${Buffer.byteLength(sql)} SQL bytes.\n`);
} finally { await client.end(); }
