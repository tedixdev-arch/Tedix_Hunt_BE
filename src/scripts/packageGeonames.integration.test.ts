import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { packageGeonames } from './packageGeonames.js';
import { hashGeonames, importCities, readGeonames } from './importGeonames.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
suite('SQL package with migrations 001-034 and restricted invoker', () => {
 const admin = new Pool({ connectionString: testUrl });
 const name = 'g4c4_' + randomUUID().replaceAll('-', '');
 const role = name + '_app';
 let db: Pool;
 let dir: string;
 let paths: string[];
 const source = ['900', "Town '$tedix_geonames_package$; --", 'Town', 'Tést Alias,Other', '46', '23', 'P', 'PPL', 'RO', '', '13', '', '', '', '1234', '', '', 'Europe/Bucharest', '2026-10-01'];
 const snapshot = async () => ({
  cities: (await db.query("SELECT to_jsonb(g)-'import_id' AS city FROM geographic_cities g ORDER BY geoname_id")).rows,
  aliases: (await db.query('SELECT * FROM geographic_city_names ORDER BY geoname_id,normalized_name')).rows,
  countries: (await db.query('SELECT * FROM countries ORDER BY code')).rows,
  localities: (await db.query('SELECT * FROM localities ORDER BY id')).rows,
 });
 async function generate(fields = source, repeated = false) {
  const rows = repeated ? Array.from({length:501}, (_, i) => {
   const row=[...fields]; if(i<500) { row[1]='Earlier '+i; row[3]='Earlier alias '+i; } return row;
  }) : [fields];
  await writeFile(paths[0], rows.map(row => row.join('\t')).join('\n') + '\n');
  await packageGeonames(paths, join(dir, 'import.sql'));
  return readFile(join(dir, 'import.sql'), 'utf8');
 }
 async function execute(sql: string) {
  const c = await db.connect();
  try { await c.query(`SET ROLE "${role}"`); await c.query(sql); }
  finally { await c.query('RESET ROLE'); c.release(); }
 }
 beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'g4c4-'));
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  const url = new URL(testUrl!); url.pathname = '/' + name;
  db = new Pool({ connectionString: url.href });
  const c = await db.connect();
  try {
   await c.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
   const directory = new URL('../db/migrations/', import.meta.url);
   const migrations = await Promise.all((await readdir(directory)).filter(f => /^\d{3}_.*\.ts$/.test(f)).sort().map(async f => (await import(new URL(f,directory).href)).default));
   expect(migrations).toHaveLength(34);
   await runMigrations(c, migrations);
   await c.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO "${role}";
    GRANT SELECT ON schema_migrations TO "${role}";
    GRANT SELECT,INSERT,UPDATE,DELETE ON countries,geographic_imports,geographic_cities,geographic_city_names TO "${role}"`);
  } finally { c.release(); }
  paths = ['cities500.txt','countryInfo.txt','admin1CodesASCII.txt','admin2Codes.txt'].map(f => join(dir,f));
  await writeFile(paths[1], 'RO\t\t\t\tRomania\nHU\t\t\t\tHungary\n');
  await writeFile(paths[2], 'RO.13\tCluj\n');
  await writeFile(paths[3], '');
 }, 30000);
 afterAll(async () => {
  if (db) await db.end();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
  if (dir) await rm(dir, {recursive:true,force:true});
 });
 it('matches direct importer, including hostile quotes/delimiters; repeat creates only new metadata', async () => {
  const sql = await generate(source, true);
  const c = await db.connect();
  try {
   await c.query('BEGIN');
   await importCities(c, readGeonames(paths[0],paths[1],paths[2],paths[3]), {
    dataset:'GeoNames cities500 + countryInfo + admin1CodesASCII + admin2Codes', sha256:await hashGeonames(paths),
   });
   await c.query('COMMIT');
  } finally { c.release(); }
  const direct = await snapshot();
  const metadata = (await db.query('SELECT source,dataset,sha256,attribution,row_count FROM geographic_imports')).rows;
  expect(metadata[0].row_count).toBe('501');
  await db.query('TRUNCATE geographic_city_names,geographic_cities,geographic_imports');
  await execute(sql);
  expect(await snapshot()).toEqual(direct);
  expect((await db.query('SELECT source,dataset,sha256,attribution,row_count FROM geographic_imports')).rows).toEqual(metadata);
  await execute(sql);
  expect(await snapshot()).toEqual(direct);
  expect((await db.query('SELECT * FROM geographic_imports WHERE completed_at IS NOT NULL')).rowCount).toBe(2);
 });
 it('retains newer names when importing an older source revision', async () => {
  const before = await snapshot();
  const fields = [...source]; fields[1]='Stale'; fields[3]='Stale alias'; fields[18]='2020-01-01';
  await execute(await generate(fields));
  expect(await snapshot()).toEqual(before);
 });
 it('preserves reconciliation and rolls back country moves and all import metadata', async () => {
  const locality = (await db.query("INSERT INTO localities(country_code,name,administrative_context,latitude,longitude,provenance) VALUES ('RO','Mapped town','County',46,23,'Fixture') RETURNING id")).rows[0].id;
  await db.query('UPDATE geographic_cities SET locality_id=$1,reconciled_by=$2,reconciliation_reason=$3,reconciled_at=now()', [locality,randomUUID(),'Fixture']);
  await execute(await generate());
  const before = await snapshot();
  const imports = (await db.query('SELECT * FROM geographic_imports ORDER BY id')).rows;
  const moved = [...source]; moved[8]='HU';
  await expect(execute(await generate(moved))).rejects.toThrow('Mapped source country changed');
  expect(await snapshot()).toEqual(before);
  expect((await db.query('SELECT * FROM geographic_imports ORDER BY id')).rows).toEqual(imports);
 });
 it('rolls back late SQL errors and permissions failures; refuses invalid source without publishing', async () => {
  const sql = await generate();
  const before = await snapshot();
  const imports = (await db.query('SELECT * FROM geographic_imports ORDER BY id')).rows;
  await expect(execute(sql.replace('END;\n$tedix_geonames_package$', "RAISE EXCEPTION 'injected test failure';\nEND;\n$tedix_geonames_package$"))).rejects.toThrow('injected test failure');
  await db.query(`REVOKE DELETE ON geographic_city_names FROM "${role}"`);
  await expect(execute(sql)).rejects.toMatchObject({code:'42501'});
  expect(await snapshot()).toEqual(before);
  expect((await db.query('SELECT * FROM geographic_imports ORDER BY id')).rows).toEqual(imports);
  const invalid=[...source]; invalid[4]='91';
  await expect(generate(invalid)).rejects.toThrow('Invalid GeoNames');
  expect(await readFile(join(dir,'import.sql'),'utf8')).toEqual(sql);
  await expect(readFile(join(dir,'import.sql.part'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('filters mixed-country input before SQL generation, preserving RO semantics on first/repeat import', async () => {
  await db.query(`GRANT DELETE ON geographic_city_names TO "${role}"`);
  await db.query('TRUNCATE geographic_city_names,geographic_cities,geographic_imports');
  const foreign = [...source]; foreign[0]='901'; foreign[8]='HU'; foreign[1]='Foreign city';
  // Missing foreign-country metadata/coordinates cannot prevent an RO package.
  const excluded = [...foreign]; excluded[0]='902'; excluded[8]='ZZ'; excluded[4]='';
  await writeFile(paths[0], [foreign, source, excluded].map(row => row.join('\t')).join('\n') + '\n');
  const result = await packageGeonames(paths, join(dir,'romania.sql'), 'romania');
  const sql = await readFile(join(dir,'romania.sql'), 'utf8');
  expect(result).toMatchObject({scope:'romania',countryCode:'RO',rows:1,bytes:Buffer.byteLength(sql),sha256:await hashGeonames(paths)});
  expect(sql).toContain('Romania only (RO)');
  const c = await db.connect();
  try {
   await c.query('BEGIN');
   await importCities(c, readGeonames(paths[0],paths[1],paths[2],paths[3],'RO'), {dataset:result.dataset,sha256:result.sha256});
   await c.query('COMMIT');
  } finally { c.release(); }
  const direct = await snapshot();
  await db.query('TRUNCATE geographic_city_names,geographic_cities,geographic_imports');
  await execute(sql);
  expect(await snapshot()).toEqual(direct);
  await execute(sql);
  expect(await snapshot()).toEqual(direct);
  expect((await db.query("SELECT count(*) FROM geographic_cities WHERE country_code <> 'RO'")).rows[0].count).toBe('0');
  expect((await db.query('SELECT count(*) FROM geographic_cities')).rows[0].count).toBe('1');
  const imports = (await db.query('SELECT dataset,sha256,row_count,completed_at FROM geographic_imports')).rows;
  expect(imports).toHaveLength(2);
  for (const item of imports) {
   expect(item).toMatchObject({dataset:result.dataset,sha256:result.sha256,row_count:'1'});
   expect(item.completed_at).not.toBeNull();
  }
  const before = await snapshot();
  await expect(execute(sql.replace('END;\n$tedix_geonames_package$', "RAISE EXCEPTION 'RO rollback';\nEND;\n$tedix_geonames_package$"))).rejects.toThrow('RO rollback');
  expect(await snapshot()).toEqual(before);
  expect((await db.query('SELECT count(*) FROM geographic_imports')).rows[0].count).toBe('2');
  await writeFile(paths[0], foreign.join('\t') + '\n');
  await expect(packageGeonames(paths, join(dir,'empty.sql'), 'romania')).rejects.toThrow('Empty import');
  await expect(readFile(join(dir,'empty.sql'))).rejects.toMatchObject({code:'ENOENT'});
 });

});
