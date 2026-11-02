import { pathToFileURL } from 'node:url';

const provider = 'development-setup';
const providerId = 'cluj-napoca';

export function seedConfiguration(env, action) {
  if (env.NODE_ENV !== 'development' || env.DEVELOPMENT_LOCALITY_SEED !== 'cluj'
      || !['apply', 'remove'].includes(action)) {
    throw new Error('Requires NODE_ENV=development, DEVELOPMENT_LOCALITY_SEED=cluj and apply or remove.');
  }
  // Deliberately never fall back to the application's DATABASE_URL.
  const url = new URL(env.DEVELOPMENT_DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !/^[a-z0-9_-]*_dev$/.test(url.pathname.slice(1))) {
    throw new Error('DEVELOPMENT_DATABASE_URL must name an explicit *_dev database.');
  }
  return { connectionString: url.href };
}

export async function clujLocality(client, action) {
  if (!['apply', 'remove'].includes(action)) throw new Error('Invalid action');
  await client.query('BEGIN');
  try {
    // Serialize with registry writers so concurrent registration cannot race the seed.
    await client.query('LOCK TABLE localities IN SHARE ROW EXCLUSIVE MODE');
    const owned = (await client.query('SELECT id, active FROM localities WHERE provider=$1 AND provider_id=$2', [provider, providerId])).rows;
    if (action === 'remove') {
      // Deactivate only our record: saved snapshots and foreign keys remain intact.
      await client.query('UPDATE localities SET active=FALSE, updated_at=now() WHERE provider=$1 AND provider_id=$2 AND active', [provider, providerId]);
    } else if (owned.length) {
      // Never silently reactivate an administratively disabled record.
      if (!owned[0].active) throw new Error('Development locality is inactive; explicit Admin reconciliation is required.');
    } else {
      const existing = (await client.query(`SELECT id, active FROM localities
        WHERE country_code='RO' AND lower(regexp_replace(name, '[^[:alnum:]]', '', 'g'))='clujnapoca'`)).rows;
      if (existing.length) {
        // Existing records belong to the registry, not this seed. Do not overwrite or approve them.
        if (existing.length !== 1 || !existing[0].active) throw new Error('Existing Cluj locality needs Admin reconciliation.');
      } else {
        await client.query(`INSERT INTO localities
          (country_code,name,administrative_context,latitude,longitude,provider,provider_id,provenance)
          VALUES ('RO','Cluj-Napoca','Cluj',46.7712,23.6236,$1,$2,$3)`,
        [provider, providerId, 'Temporary manually configured development city reference. Coordinates approximate city centre. No GeoNames source, locality approval, route certification or Template approval.']);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2];
    const configuration = seedConfiguration(process.env, action);
    const { Client } = await import('pg');
    const client = new Client(configuration);
    await client.connect();
    try { await clujLocality(client, action); } finally { await client.end(); }
    console.log(`Development Cluj locality: ${action} completed.`);
  } catch (error) {
    // Connection errors can contain credentials; never print the original error.
    console.error('Development locality command refused or failed. Check explicit development configuration and registry conflicts.');
    process.exitCode = 1;
  }
}
