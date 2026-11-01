import { closeSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hashGeonames, importCities, readGeonames, type ImportTarget } from './importGeonames.js';

// This adapter renders the importer's SQL, never a snapshot of database rows.
// Server-side conditions are evaluated against the destination at execution time.
const RUN = '__tedix_sql_import_run__';
export class SqlImportTarget implements ImportTarget {
 constructor(private write: (sql: string) => void) {}
 private literal(value: unknown): string {
  if (value === RUN) return '_tedix_import_run';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `ARRAY[${value.map(item => this.literal(item)).join(',')}]`;
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Unsupported SQL parameter');
  // Hex prevents source data from closing the DO delimiter, SQL quotes or comments.
  return `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(value).toString('hex')}','hex'),'UTF8')`;
 }
 private bind(sql: string, values: unknown[] = []) {
  const used = new Set<number>();
  const result = sql.replace(/\$(\d+)/g, (_, n) => {
   const index = Number(n) - 1;
   if (index < 0 || index >= values.length) throw new Error('Missing SQL parameter');
   used.add(index); return this.literal(values[index]);
  });
  if (used.size !== values.length) throw new Error('Unused SQL parameter');
  return result;
 }
 async execute(sql: string, values?: unknown[]) {
  if (!/^(SELECT|INSERT|DELETE|UPDATE)\b/.test(sql)) throw new Error('Unsupported import statement');
  this.write(this.bind(sql.replace(/^SELECT\b/, 'PERFORM'), values) + ';\n');
 }
 async beginImport(sql: string, values: unknown[]) {
  if (!sql.endsWith(' RETURNING id')) throw new Error('Unsupported import identifier statement');
  this.write(this.bind(sql, values) + ' INTO _tedix_import_run;\n');
  return RUN;
 }
 async assertNoRows(sql: string, values: unknown[], message: string) {
  // Same predicate and message as the database target; do not decide offline.
  this.write(`IF EXISTS (${this.bind(sql, values)}) THEN RAISE EXCEPTION USING MESSAGE = ${this.literal(message)}; END IF;\n`);
 }
}

export async function packageGeonames(paths: string[], output: string, scope: 'romania' | 'worldwide' = 'worldwide') {
 if (!['romania', 'worldwide'].includes(scope)) throw new Error('Unsupported package scope');
 const countryCode = scope === 'romania' ? 'RO' : undefined;
 const label = countryCode ? 'Romania only (RO); subset of cities500, not a worldwide catalog' : 'Worldwide cities500 populated-place catalog';
 const dataset = 'GeoNames cities500 + countryInfo + admin1CodesASCII + admin2Codes' + (countryCode ? ' — Romania only (country_code = RO)' : '');
 if (paths.length !== 4) throw new Error('Four official input files required');
 const sha256 = await hashGeonames(paths);
 const partial = output + '.part';
 const fd = openSync(partial, 'wx', 0o600);
 let bytes = 0;
 const write = (sql: string) => {
  bytes += Buffer.byteLength(sql);
  // Query Tool sends the whole statement: refuse unbounded client/server memory use.
  if (bytes > 512 * 1024 * 1024) throw new Error('SQL exceeds 512 MiB package ceiling; BLOCKED');
  writeFileSync(fd, sql);
 };
 try {
  write(`-- GeoNames (CC BY 4.0): https://www.geonames.org/\n-- Scope: ${label}\n-- Execute the entire file once. One statement; invoker permissions; atomic on error.\nDO $tedix_geonames_package$\nDECLARE _tedix_import_run uuid;\nBEGIN\nPERFORM pg_catalog.set_config('search_path','pg_catalog,public,pg_temp',true);\nIF (SELECT count(*) FROM public.schema_migrations WHERE id IN ('032_geographic_catalog','033_geographic_import_completion','034_geonames_kosovo_country')) <> 3 THEN\n RAISE EXCEPTION 'Required geographic migrations 032-034 missing';\nEND IF;\n`);
  const result = await importCities(new SqlImportTarget(write), readGeonames(paths[0], paths[1], paths[2], paths[3], countryCode), {
   dataset, sha256,
  });
  write('END;\n$tedix_geonames_package$ LANGUAGE plpgsql;\n');
  closeSync(fd);
  renameSync(partial, output);
  return { scope, countryCode: countryCode ?? null, dataset, rows: result.rows, sha256, bytes };
 } catch (error) {
  try { closeSync(fd); } catch { /* already closed before rename failure */ }
  rmSync(partial, { force: true });
  throw error;
 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const args = process.argv.slice(2);
 const scope = args[0] === '--romania-only' ? (args.shift(), 'romania' as const) : 'worldwide' as const;
 const [output, ...paths] = args;
 if (!output) throw new Error('Usage: packageGeonames [--romania-only] output.sql cities500.txt countryInfo.txt admin1CodesASCII.txt admin2Codes.txt');
 packageGeonames(paths, output, scope).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
