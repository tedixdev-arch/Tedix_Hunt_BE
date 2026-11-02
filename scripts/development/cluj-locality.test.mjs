import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clujLocality, seedConfiguration } from './cluj-locality.mjs';

const development = { NODE_ENV: 'development', DEVELOPMENT_LOCALITY_SEED: 'cluj', DEVELOPMENT_DATABASE_URL: 'postgres://localhost/tedix_dev' };
test('requires explicit development environment, opt-in and dedicated development URL', () => {
  assert.equal(seedConfiguration(development, 'apply').connectionString, development.DEVELOPMENT_DATABASE_URL);
  for (const env of [{}, { ...development, NODE_ENV: 'production' }, { ...development, DEVELOPMENT_LOCALITY_SEED: '' }, { ...development, DEVELOPMENT_DATABASE_URL: 'postgres://localhost/tedix' }, { ...development, DEVELOPMENT_DATABASE_URL: '', DATABASE_URL: development.DEVELOPMENT_DATABASE_URL }]) {
    assert.throws(() => seedConfiguration(env, 'apply'));
    assert.throws(() => seedConfiguration(env, 'remove'));
  }
  assert.throws(() => seedConfiguration(development, 'unknown'));
});
function registry(owned = [], existing = [], fail = false) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT')) return { rows: sql.includes('provider=') ? owned : existing };
    if (fail && sql.startsWith('INSERT')) throw new Error('database failure');
    return { rows: [] };
  } };
}
test('seed inserts a manual server-generated UUID reference without approval or GeoNames writes', async () => {
  const db = registry(); await clujLocality(db, 'apply');
  const inserts = db.calls.filter(call => call.sql.startsWith('INSERT'));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /INSERT INTO localities/);
  assert.doesNotMatch(inserts[0].sql, /\bid\b|approval|geographic_cities|hunt_templates/);
  assert.equal(inserts[0].params[0], 'development-setup');
  assert.equal(db.calls.at(-1).sql, 'COMMIT');
});
test('repeat application and an existing active reference do not mutate registry records', async () => {
  for (const db of [registry([{ id: 'saved', active: true }]), registry([], [{ id: 'registered', active: true }])]) {
    await clujLocality(db, 'apply');
    assert.equal(db.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql)), false);
  }
});
test('inactive and ambiguous records fail closed and roll back', async () => {
  for (const db of [registry([{ active: false }]), registry([], [{ active: false }]), registry([], [{ active: true }, { active: true }]), registry([], [], true)]) {
    await assert.rejects(clujLocality(db, 'apply'));
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  }
});
test('removal only deactivates seed-owned locality; no deletes or snapshot rewrites', async () => {
  const db = registry(); await clujLocality(db, 'remove');
  const writes = db.calls.filter(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /SET active=FALSE/);
  assert.deepEqual(writes[0].params, ['development-setup', 'cluj-napoca']);
});
