import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, appendFileSync } from 'node:fs';

// Fail closed before importing modules which initialize the application pool.
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.protocol, 'postgresql:');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '5432');
assert.equal(url.pathname, '/geonames_ci');
assert.equal(decodeURIComponent(url.username), 'geonames_ci');
const phase = process.argv[2];
assert.ok(['initial', 'first', 'repeat'].includes(phase));
const { GeographicCatalog } = await import('../../dist/models/GeographicCatalog.js');
const { normalizeCityName } = await import('../../dist/domain/geographicNames.js');
const { pool } = await import('../../dist/lib/postgres.js');
const dir = process.env.GEONAMES_DIR;
const report = text => appendFileSync(dir + '/acceptance.md', '- ' + text + '\n');

async function verifyClujSource(cluj) {
  // Read the unmodified official record, never a hand-maintained alias fixture.
  let source;
  const lines = createInterface({
    input: createReadStream(dir + '/cities500.txt', { encoding: 'utf8' }), crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const fields = line.split('\t');
    if (fields[0] !== '681290') continue;
    assert.equal(fields.length, 19);
    assert.equal(source, undefined, 'Duplicate Cluj source ID');
    source = fields;
  }
  assert.ok(source, 'Cluj stable ID missing from official snapshot');
  assert.equal(source[1], 'Cluj-Napoca');
  assert.equal(source[8], 'RO');
  assert.ok(source[4].trim() && source[5].trim());
  assert.ok(Math.abs(cluj.latitude - Number(source[4])) < 1e-7);
  assert.ok(Math.abs(cluj.longitude - Number(source[5])) < 1e-7);
  const alternateNames = source[3].split(',').filter(Boolean);
  for (const name of ['Klausenburg', 'Kolozsvár']) {
    const present = alternateNames.includes(name);
    report('SOURCE (' + phase + '): ' + name + ' ' + (present ? 'present' : 'absent')
      + ' in official Cluj alternate-name field; absence is not an importer defect.');
  }
  // Check all normalized input names, including the ASCII field. One-character
  // names are valid stored aliases but are below the API search minimum.
  const aliases = [source[2], ...alternateNames].filter(Boolean);
  const expected = [...new Set([source[1], ...aliases].map(normalizeCityName).filter(Boolean))].sort();
  const actual = (await pool.query(
    'SELECT normalized_name FROM geographic_city_names WHERE geoname_id=$1', ['681290'],
  )).rows.map(row => row.normalized_name).sort();
  assert.deepEqual(actual, expected, 'Imported names differ from official record');

  async function search(country, query, requireCluj) {
    let after = '0';
    do {
      const page = await GeographicCatalog.search(country, query, 50, after);
      assert.ok(page.cities.every(city => city.countryCode === country));
      const found = page.cities.some(city => city.geographicId === '681290');
      if (requireCluj && found) return;
      if (!requireCluj) assert.equal(found, false, 'Cluj leaked across country filter');
      if (page.nextAfter === null) break;
      assert.ok(BigInt(page.nextAfter) > BigInt(after), 'Search cursor must advance');
      after = page.nextAfter;
    } while (true);
    assert.equal(requireCluj, false, 'Source name not searchable');
  }
  // Primary-name discovery remains mandatory regardless of source alias coverage.
  const queries = new Set(['cluj', source[1]]);
  for (const alias of aliases) {
    if (normalizeCityName(alias).length < 2) continue;
    queries.add(alias);
    queries.add(normalizeCityName(alias));
    queries.add(alias.toUpperCase());
  }
  for (const query of queries) {
    await search('RO', query, true);
    await search('HU', query, false);
  }
  report('PASS (' + phase + '): exact source coordinates and normalized names; '
    + alternateNames.length + ' official alternate names; ' + queries.size
    + ' primary/alias query variants with RO/HU filtering. Names shorter than the search minimum verified in storage.');
}

try {
  const version = (await pool.query('SHOW server_version_num')).rows[0].server_version_num;
  assert.equal(Math.floor(Number(version) / 10000), 17);
  if (phase === 'initial') {
    assert.equal((await GeographicCatalog.status()).status, 'not_imported');
    await assert.rejects(GeographicCatalog.search('RO', 'cluj', 50, '0'), { code: 'catalog_not_imported', status: 503 });
    assert.equal((await pool.query('SELECT count(*) FROM geographic_imports')).rows[0].count, '0');
    report('PASS: PostgreSQL 17; empty catalog reports not_imported and rejects search.');
  } else {
    assert.deepEqual(await GeographicCatalog.status(), { source: 'geonames', status: 'ready', nextAction: null });
    const cluj = await GeographicCatalog.get('681290');
    assert.equal(cluj.name, 'Cluj-Napoca');
    assert.equal(cluj.countryCode, 'RO');
    assert.ok(Math.abs(cluj.latitude - 46.77) < 0.1 && Math.abs(cluj.longitude - 23.59) < 0.1);
    assert.equal(cluj.geographicId, '681290');
    await verifyClujSource(cluj);
    // Verify exact importer provenance, including the importer's file-boundary hash.
    const hash = createHash('sha256');
    for (const [i, name] of ['cities500.txt', 'countryInfo.txt', 'admin1CodesASCII.txt', 'admin2Codes.txt'].entries()) {
      hash.update('file:' + i + '\0');
      for await (const chunk of createReadStream(dir + '/' + name)) hash.update(chunk);
      hash.update('\0');
    }
    const sourceHash = hash.digest('hex');
    const imports = (await pool.query('SELECT sha256, completed_at, row_count FROM geographic_imports ORDER BY imported_at')).rows;
    assert.equal(imports.length, phase === 'first' ? 1 : 2);
    for (const item of imports) {
      assert.equal(item.sha256, sourceHash);
      assert.ok(item.completed_at && Number(item.row_count) > 0);
      assert.equal(item.row_count, imports[0].row_count);
    }
    // Hash every city's semantic fields and sorted aliases, bounded in memory.
    // Import run IDs/timestamps are expected to change; source IDs and mappings must not.
    const fingerprint = createHash('sha256');
    let after = '0', count = 0;
    for (;;) {
      const rows = (await pool.query(`
        SELECT g.geoname_id::text AS id, to_jsonb(g)-'import_id' AS city,
          ARRAY(SELECT n.normalized_name FROM geographic_city_names n
            WHERE n.geoname_id=g.geoname_id ORDER BY n.normalized_name COLLATE "C") AS aliases
        FROM geographic_cities g WHERE g.geoname_id>$1::bigint ORDER BY g.geoname_id LIMIT 1000`, [after])).rows;
      if (!rows.length) break;
      for (const row of rows) fingerprint.update(JSON.stringify(row) + '\n');
      count += rows.length; after = rows.at(-1).id;
    }
    assert.equal(count, Number(imports[0].row_count));
    const snapshot = { count, sha256: fingerprint.digest('hex'),
      localities: (await pool.query('SELECT * FROM localities ORDER BY id')).rows };
    // Imports must never create application localities.
    assert.equal(snapshot.localities.length, 0);
    if (phase === 'first') writeFileSync(dir + '/fingerprint.json', JSON.stringify(snapshot));
    else assert.deepEqual(snapshot, JSON.parse(readFileSync(dir + '/fingerprint.json', 'utf8')));
    report('PASS (' + phase + '): ready; Cluj-Napoca 681290; RO/HU filtering; official-source aliases; provenance; ' + count + ' cities; no locality creation' + (phase === 'repeat' ? '; identical full catalog/alias fingerprint after reimport.' : '.'));
  }
} catch (error) {
  report('FAIL (' + phase + '): acceptance assertion or database operation failed; see failing step.');
  // Avoid printing connection configuration or driver errors that may contain credentials.
  console.error('GeoNames acceptance failed:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await pool.end();
}
