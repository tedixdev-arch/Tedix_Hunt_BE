import 'dotenv/config';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { normalizeCityName } from '../domain/geographicNames.js';
import { importCities, type CityImport } from './importGeonames.js';

// Curated prototype data, not a downloaded worldwide GeoNames snapshot.
const city: CityImport = {
  id: '681290', country: 'RO', countryName: 'Romania', name: 'Cluj-Napoca',
  aliases: [], context: 'Cluj', admin1: '13', admin1Name: 'Cluj', admin2: '',
  latitude: 46.7712, longitude: 23.6236, population: 0, modified: '2026-11-03',
};
const dataset = 'Development prototype only: curated Romania / Cluj / Cluj-Napoca; population unknown (0 sentinel)';
const identity = (name: string) => normalizeCityName(name).replace(/[^\p{L}\p{N}]/gu, '');

/** Owns its transaction. Never runs from startup/migrations or modifies existing localities/approvals. */
export async function seedDevelopmentCluj(client: PoolClient, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== 'development') throw new Error('Cluj prototype seed requires NODE_ENV=development');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='5s'");
    // Same order as importer/registry writers; table lock also excludes concurrent manual inserts.
    await client.query('SELECT pg_advisory_xact_lock(1907202032)');
    await client.query("INSERT INTO countries(code,display_name) VALUES('RO','Romania') ON CONFLICT DO NOTHING");
    await client.query("SELECT code FROM countries WHERE code='RO' FOR UPDATE");
    let catalog = (await client.query('SELECT * FROM geographic_cities WHERE geoname_id=681290 FOR UPDATE')).rows[0];
    if (catalog && (catalog.country_code !== 'RO' || catalog.admin1_code !== '13' || identity(catalog.name) !== 'clujnapoca')) {
      throw new Error('Conflicting Cluj catalog identity; explicit Admin reconciliation required');
    }
    await client.query('LOCK TABLE localities IN SHARE ROW EXCLUSIVE MODE');
    const aliases = new Set(['clujnapoca', ...(await client.query(
      'SELECT normalized_name FROM geographic_city_names WHERE geoname_id=681290',
    )).rows.map(row => identity(row.normalized_name))]);
    const candidates = (await client.query(`SELECT * FROM localities WHERE country_code='RO'
      OR (provider='geonames' AND provider_id='681290')
      OR (provider='development-setup' AND provider_id='cluj-napoca') OR id=$1`, [catalog?.locality_id ?? null])).rows
      .filter(row => row.id === catalog?.locality_id || (row.country_code === 'RO' && aliases.has(identity(row.name)))
        || (row.provider === 'geonames' && row.provider_id === '681290')
        || (row.provider === 'development-setup' && row.provider_id === 'cluj-napoca'));
    if (candidates.length > 1 || candidates.some(row => !row.active || row.country_code !== 'RO')) {
      throw new Error('Inactive or ambiguous Cluj locality; explicit Admin reconciliation required');
    }
    let locality = candidates[0];
    if (locality && (await client.query('SELECT 1 FROM geographic_cities WHERE locality_id=$1 AND geoname_id<>681290', [locality.id])).rowCount) {
      throw new Error('Cluj locality already mapped to another city; explicit Admin reconciliation required');
    }
    if (!locality) locality = (await client.query(`INSERT INTO localities
      (country_code,name,administrative_context,latitude,longitude,provider,provider_id,provenance)
      VALUES('RO','Cluj-Napoca','Cluj',46.7712,23.6236,'geonames','681290',$1) RETURNING *`,
    ['Curated development prototype reference; GeoNames (CC BY 4.0), https://www.geonames.org/681290; no approval or eligibility conferred.'])).rows[0];

    if (!catalog) {
      await importCities(client, [city], { dataset, sha256: createHash('sha256').update(JSON.stringify(city)).digest('hex') });
      catalog = (await client.query('SELECT * FROM geographic_cities WHERE geoname_id=681290')).rows[0];
    } else {
      // Preserve an existing real import, its metadata and source coordinates.
      await client.query(`INSERT INTO geographic_regions(country_code,admin1_code,display_name,import_id)
        VALUES('RO','13','Cluj',$1) ON CONFLICT DO NOTHING`, [catalog.import_id]);
      await client.query(`INSERT INTO geographic_city_names(geoname_id,country_code,normalized_name)
        VALUES(681290,'RO','cluj-napoca') ON CONFLICT DO NOTHING`);
      const completed = (await client.query('SELECT completed_at,row_count FROM geographic_imports WHERE id=$1', [catalog.import_id])).rows[0];
      if (!completed?.completed_at || Number(completed.row_count) < 1) throw new Error('Existing Cluj import is incomplete; repair import before seeding');
    }
    if (!catalog.locality_id) await client.query('UPDATE geographic_cities SET locality_id=$1 WHERE geoname_id=681290', [locality.id]);
    await client.query('COMMIT');
    return { geographicId: city.id, localityId: locality.id as string };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  if (process.env.NODE_ENV !== 'development') throw new Error('Cluj prototype seed requires NODE_ENV=development');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required; select the development database explicitly');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await db.connect();
    try { console.log(await seedDevelopmentCluj(client)); } finally { client.release(); }
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
