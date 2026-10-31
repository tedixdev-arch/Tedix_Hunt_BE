import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; use a disposable local PostgreSQL cluster with CREATEDB.');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
const { swaggerSpec } = await import('../dist/lib/swagger.js');
const paths = ['/api/hunts/{id}/participants/enroll','/api/hunts/{id}/participants/me',
  '/api/hunts/{id}/checkpoints/{checkpointId}/access','/api/hunts/{id}/checkpoints/{checkpointId}/proximity'];
for (const path of paths) assert.ok(swaggerSpec.paths[path]);
for (const path of ['/api/hunts/{id}/checkpoint-radii','/api/admin/templates/review/{key}/checkpoint-radii']) {
  assert.ok(swaggerSpec.paths[path]?.patch);
  assert.equal(swaggerSpec.paths[path].patch.requestBody.content['application/json'].schema.additionalProperties, false);
}
assert.equal(swaggerSpec.components.schemas.CheckpointRadiiPatch.additionalProperties, false);
assert.ok(swaggerSpec.components.schemas.Hunt.properties.checkpointRadiusConfiguration);

assert.equal(swaggerSpec.components.schemas.ParticipantHuntAccessContext.additionalProperties, false);
assert.ok(!Object.keys(swaggerSpec.paths).some(p => p.includes('/challenges/') || p === '/api/hunts/{id}/progress'));
// Resolve every local OpenAPI reference.
function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref?.startsWith('#/')) assert.ok(value.$ref.slice(2).split('/').reduce((o,k) => o?.[k], swaggerSpec), value.$ref);
  for (const v of Object.values(value)) walk(v);
}
walk(swaggerSpec);
console.log(`Runtime Swagger: ${Object.keys(swaggerSpec.paths).length} paths; four access operations, two radius operations, resolved references; no proposed gameplay endpoints.`);
const { discoverMigrations } = await import('../dist/db/migrations/index.js');
const { runMigrations } = await import('../dist/db/migrate.js');
const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const names = [`compiled_${randomUUID().replaceAll('-','')}`, `bootstrap_${randomUUID().replaceAll('-','')}`];
try {
  for (let i=0; i<names.length; i++) {
    await admin.query(`CREATE DATABASE "${names[i]}"`);
    const url = new URL(process.env.TEST_DATABASE_URL); url.pathname=`/${names[i]}`;
    const pool = new Pool({connectionString:url.toString()}); const client=await pool.connect();
    try {
      if (i===0) {
        await client.query(await readFile(new URL('../src/db/pre_migration_baseline.sql',import.meta.url),'utf8'));
        const migrations=await discoverMigrations(new URL('../dist/db/migrations',import.meta.url).pathname);
        assert.equal((await runMigrations(client,migrations)).length,31);
        assert.deepEqual(await runMigrations(client,migrations),[]);
        console.log('Compiled migrations: 31 applied; repeat 0.');
      } else {
        await client.query(await readFile(new URL('../src/db/schema.sql',import.meta.url),'utf8'));
        assert.ok((await client.query("SELECT to_regclass('participant_checkpoint_access') AS t")).rows[0].t);
        console.log('Full schema bootstrap: passed, including Participant access tables/trigger.');
      }
    } finally { client.release(); await pool.end(); }
  }
} finally {
  for (const name of names) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
}
