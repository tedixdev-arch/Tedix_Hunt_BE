import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import reviewMigration from './migrations/043_content_review.js';
import type { Migration } from './migrations/types.js';
import { exerciseFixtures } from '../test/customExercises.js';

const testUrl=process.env.TEST_DATABASE_URL;
(testUrl?describe:describe.skip)('C2c upgrade safety and fresh schema parity',()=>{
 const admin=new Pool({connectionString:testUrl});
 const name='content_migration_'+randomUUID().replaceAll('-','');
 let db:Pool,created=false;
 let migrations:Migration[];
 beforeAll(async()=>{
  await admin.query(`CREATE DATABASE "${name}"`);created=true;
  const url=new URL(testUrl!);url.pathname='/'+name;db=new Pool({connectionString:url.href});
  const directory=new URL('./migrations/',import.meta.url);
  migrations=await Promise.all((await readdir(directory)).filter(n=>/^\d{3}_.*\.ts$/.test(n)).sort().map(async n=>(await import(new URL(n,directory).href)).default));
  const c=await db.connect();
  try{await c.query(await readFile(new URL('./pre_migration_baseline.sql',import.meta.url),'utf8'));await runMigrations(c,migrations.filter(m=>m.id<reviewMigration.id));}finally{c.release();}
 });
 afterAll(async()=>{await db?.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();});
 it('fails closed on legacy promotions, then preserves C2a drafts and installs identical fresh-schema protections',async()=>{
  const c=await db.connect();
  try {
   await c.query('BEGIN');
   const owner=(await c.query("INSERT INTO users(email,role) VALUES ('migration@example.invalid','participant') RETURNING id")).rows[0].id;
   const id=(await c.query('INSERT INTO library_content(owner_id,head_version) VALUES ($1,1) RETURNING id',[owner])).rows[0].id;
   const revision=(await c.query(`INSERT INTO library_content_revisions(content_id,version,exercise,geographic_scope) VALUES ($1,1,$2,'universal') RETURNING id`,[id,exerciseFixtures[0]])).rows[0].id;
   await c.query('COMMIT');
   const before=(await c.query('SELECT to_jsonb(r) row FROM library_content_revisions r')).rows;
   await c.query('BEGIN');await c.query("UPDATE library_content_revisions SET status='approved' WHERE id=$1",[revision]);
   await expect(reviewMigration.up(c)).rejects.toThrow('Reconcile legacy non-draft Content');
   await c.query('ROLLBACK');
   expect((await c.query("SELECT to_regclass('library_content_review_events') name")).rows[0].name).toBeNull();
   expect(await runMigrations(c,migrations)).toEqual(['043_content_review','044_approved_content_discovery']);
   expect(await runMigrations(c,migrations)).toEqual([]);
   expect((await c.query('SELECT to_jsonb(r) row FROM library_content_revisions r')).rows).toEqual(before);
   const inspect=async()=>({
    columns:(await c.query(`SELECT table_name,column_name,data_type,column_default,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'library_content%' ORDER BY table_name,ordinal_position`)).rows,
    constraints:(await c.query(`SELECT t.relname,pg_get_constraintdef(k.oid) def FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid WHERE t.relname LIKE 'library_content%' ORDER BY 1,2`)).rows,
    triggers:(await c.query(`SELECT pg_get_triggerdef(g.oid) def FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid WHERE t.relname LIKE 'library_content%' AND NOT g.tgisinternal ORDER BY 1`)).rows,
    functions:(await c.query(`SELECT proname,prosrc FROM pg_proc WHERE proname IN ('protect_library_revision','protect_library_identity','guard_library_review_event','apply_library_review_event') ORDER BY 1`)).rows,
   });
   const indexes=async()=>(await c.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename LIKE 'library_content%' ORDER BY indexname")).rows;
   const upgradedIndexes=await indexes();
   expect(upgradedIndexes.some(i=>i.indexname==='library_content_approved_latest')).toBe(true);
   const upgraded=await inspect();
   await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
   await c.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
   expect(await inspect()).toEqual(upgraded);
   expect(await indexes()).toEqual(upgradedIndexes);
  } finally {c.release();}
 });
});
