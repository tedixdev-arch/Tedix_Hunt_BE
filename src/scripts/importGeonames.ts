import 'dotenv/config';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { normalizeCityName } from '../domain/geographicNames.js';

export interface CityImport {
 id: string; country: string; countryName: string; name: string; aliases: string[];
 context: string; admin1: string; admin2: string; latitude: number; longitude: number;
 population: number; modified: string;
}
const bounded = (v: unknown, n: number): v is string => typeof v === 'string' && v.trim().length>0 && v.length<=n;
export function validateCity(c: CityImport) {
 if (!c || !/^[1-9]\d{0,14}$/.test(c.id) || !/^[A-Z]{2}$/.test(c.country) || !bounded(c.countryName,100)
  || !bounded(c.name,200) || !bounded(c.context,200) || typeof c.admin1!=='string' || c.admin1.length>40
  || typeof c.admin2!=='string' || c.admin2.length>40 || !Array.isArray(c.aliases) || c.aliases.length>10000
  || c.aliases.some(n=>!bounded(n,300)) || !Number.isFinite(c.latitude) || Math.abs(c.latitude)>90
  || !Number.isFinite(c.longitude) || Math.abs(c.longitude)>180 || !Number.isSafeInteger(c.population) || c.population<0
  || !/^\d{4}-\d{2}-\d{2}$/.test(c.modified) || Number.isNaN(Date.parse(c.modified))) throw new Error('Invalid GeoNames populated-place row');
 return c;
}

/** Output boundary shared by the database client and the offline SQL package writer.
 * All validation, batching, normalization and reconciliation stays in importCities.
 */
export interface ImportTarget {
 execute(sql: string, values?: unknown[]): Promise<void>;
 beginImport(sql: string, values: unknown[]): Promise<string>;
 assertNoRows(sql: string, values: unknown[], message: string): Promise<void>;
}
function databaseTarget(client: PoolClient): ImportTarget {
 return {
  async execute(sql, values) { await client.query(sql, values); },
  async beginImport(sql, values) { return (await client.query(sql, values)).rows[0].id; },
  async assertNoRows(sql, values, message) { if ((await client.query(sql, values)).rowCount) throw new Error(message); },
 };
}

/** Atomic import; caller owns transaction. No locality, Template or Hunt updates. */
export async function importCities(connection: PoolClient | ImportTarget, cities: AsyncIterable<CityImport> | Iterable<CityImport>, provenance: { dataset: string; sha256: string }) {
 const client = 'execute' in connection ? connection : databaseTarget(connection);
 if (!bounded(provenance.dataset,500) || !/^[a-f0-9]{64}$/.test(provenance.sha256)) throw new Error('Invalid import provenance');
 // Serialize catalog imports and prevent concurrent source-country moves during reconciliation.
 await client.execute('SELECT pg_advisory_xact_lock(1907202032)');
 const run = await client.beginImport(`INSERT INTO geographic_imports(source,dataset,sha256,attribution) VALUES('geonames',$1,$2,'GeoNames (CC BY 4.0)') RETURNING id`,[provenance.dataset,provenance.sha256]);
 let count=0;
 // Batches bound memory; one transaction makes failed imports invisible and fully retryable.
 let batch: CityImport[]=[];
 async function flush() {
  for (const country of [...new Set(batch.map(c=>c.country))].sort()) {
   const c=batch.find(c=>c.country===country)!;
   await client.execute('INSERT INTO countries(code,display_name) VALUES($1,$2) ON CONFLICT(code) DO NOTHING',[country,c.countryName]);
   await client.execute('SELECT code FROM countries WHERE code=$1 FOR UPDATE',[country]);
  }
  // Repeated IDs within a batch: last source row wins, preserving the source identity.
  const rows=[...new Map(batch.map(c=>[c.id,c])).values()];
  await client.execute('SELECT geoname_id FROM geographic_cities WHERE geoname_id=ANY($1::bigint[]) ORDER BY geoname_id FOR UPDATE',[rows.map(c=>c.id)]);
  await client.assertNoRows(`SELECT 1 FROM geographic_cities g JOIN jsonb_to_recordset($1::jsonb) AS r(id text,country text,modified text)
    ON g.geoname_id=r.id::bigint WHERE g.locality_id IS NOT NULL AND g.country_code<>r.country AND g.source_modified<=r.modified::date LIMIT 1`,[JSON.stringify(rows)], 'Mapped source country changed; explicit reconciliation required before import');
  await client.execute(`INSERT INTO geographic_cities(geoname_id,country_code,name,administrative_context,admin1_code,admin2_code,latitude,longitude,population,source_modified,import_id)
   SELECT id::bigint,country,name,context,admin1,admin2,latitude,longitude,population,modified::date,$2::uuid FROM jsonb_to_recordset($1::jsonb)
    AS r(id text,country text,name text,context text,admin1 text,admin2 text,latitude float8,longitude float8,population bigint,modified text)
   ON CONFLICT(geoname_id) DO UPDATE SET country_code=EXCLUDED.country_code,name=EXCLUDED.name,administrative_context=EXCLUDED.administrative_context,
    admin1_code=EXCLUDED.admin1_code,admin2_code=EXCLUDED.admin2_code,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,
    population=EXCLUDED.population,source_modified=EXCLUDED.source_modified,import_id=EXCLUDED.import_id
   WHERE geographic_cities.source_modified<=EXCLUDED.source_modified`,[JSON.stringify(rows),run]);
  // Only replace aliases for rows accepted by this run (an older source revision must not overwrite names).
  const ids=rows.map(c=>c.id);
  await client.execute('DELETE FROM geographic_city_names WHERE geoname_id=ANY($1::bigint[]) AND geoname_id IN(SELECT geoname_id FROM geographic_cities WHERE import_id=$2)',[ids,run]);
  const names=rows.flatMap(c=>[...new Set([c.name,...c.aliases].map(normalizeCityName).filter(Boolean))].map(name=>({id:c.id,country:c.country,name})));
  await client.execute(`INSERT INTO geographic_city_names SELECT r.id::bigint,r.country,r.name FROM jsonb_to_recordset($1::jsonb) AS r(id text,country text,name text)
   JOIN geographic_cities g ON g.geoname_id=r.id::bigint AND g.import_id=$2 ON CONFLICT DO NOTHING`,[JSON.stringify(names),run]);
  count+=batch.length; batch=[];
 }
 for await (const city of cities) { batch.push(validateCity(city)); if(batch.length===500) await flush(); }
 if(batch.length) await flush();
 if(!count) throw new Error('Empty import');
 await client.execute('UPDATE geographic_imports SET completed_at=clock_timestamp(),row_count=$2 WHERE id=$1',[run,count]);
 return { importId:run, rows:count };
}

async function lines(path: string) {
 return createInterface({input:createReadStream(path,{encoding:'utf8'}),crlfDelay:Infinity});
}
async function metadata(path: string, country=false) {
 const result=new Map<string,string>();
 for await(const line of await lines(path)) { if(!line || line.startsWith('#'))continue; const f=line.split('\t'); result.set(f[0],f[country?4:1]); }
 return result;
}
export async function* readGeonames(citiesPath: string, countriesPath: string, admin1Path: string, admin2Path: string): AsyncGenerator<CityImport> {
 const countries=await metadata(countriesPath,true), admin1=await metadata(admin1Path), admin2=await metadata(admin2Path);
 for await(const line of await lines(citiesPath)) {
  if(!line || line.startsWith('#'))continue;
  const f=line.split('\t'); if(f.length!==19)throw new Error('Expected official 19-column GeoNames TSV');
  if(f[6]!=='P' || !/^(PPL|PPLA[2-5]?|PPLC|PPLG|PPLL|PPLR|STLMT)$/.test(f[7]))continue;
  if(!f[4].trim() || !f[5].trim())throw new Error('Missing GeoNames coordinates');
  const countryName=countries.get(f[8]); if(!countryName)throw new Error(`Missing country metadata: ${f[8]}`);
  const a1=f[10]?admin1.get(`${f[8]}.${f[10]}`):undefined;
  // Administrative dictionaries supply optional display labels, not city identity.
  // Never infer an omitted parent code or join admin2 without its full source key.
  const a2=f[10]&&f[11]?admin2.get(`${f[8]}.${f[10]}.${f[11]}`):undefined;
  yield validateCity({id:f[0],country:f[8],countryName,name:f[1],aliases:[f[2],...f[3].split(',')].filter(Boolean),
   context:[a2,a1].filter(label=>label?.trim()).join(', ') || countryName,admin1:f[10],admin2:f[11],latitude:Number(f[4]),longitude:Number(f[5]),population:Number(f[14]),modified:f[18]});
 }
}
export async function hashGeonames(paths: string[]) {
 // Hash exact input streams with file boundaries, bounded in memory.
 const hash=createHash('sha256');
 for(const [i,path] of paths.entries()){ hash.update(`file:${i}\0`); for await(const chunk of createReadStream(path))hash.update(chunk); hash.update('\0'); }
 return hash.digest('hex');
}
async function main() {
 const paths=process.argv.slice(2);
 if(paths.length!==4)throw new Error('Usage: import-geonames cities500.txt countryInfo.txt admin1CodesASCII.txt admin2Codes.txt');
 const sha256=await hashGeonames(paths);
 const db=new Pool({connectionString:process.env.DATABASE_URL});
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
 const client=await db.connect();
 try { await client.query('BEGIN'); const result=await importCities(client,readGeonames(paths[0],paths[1],paths[2],paths[3]),{dataset:'GeoNames cities500 + countryInfo + admin1CodesASCII + admin2Codes',sha256}); await client.query('COMMIT'); console.log(result); }
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await db.end();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(error=>{console.error(error);process.exitCode=1;});
