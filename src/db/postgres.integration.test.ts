import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { disconnectPostgres } from '../lib/postgres.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

// Use a dedicated disposable database; the rollback checks change migration history.
describe.skipIf(!databaseUrl)('PostgreSQL integration', () => {
  const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
  const env = { ...process.env, DATABASE_URL: databaseUrl!, MONGODB_URI: '' };
  const migrate = (direction: string) => exec(process.execPath, ['dist/db/migrate.js', direction], { cwd: root, env });
  afterAll(async () => { await disconnectPostgres(); await pool.end(); });

  it('applies, repeats, rolls back and reapplies the compiled migration command', async () => {
    await migrate('up');
    await migrate('up');
    expect((await pool.query('SELECT name FROM pgmigrations ORDER BY name')).rows).toEqual([
      { name: '1789065600000_foundation' }, { name: '1789214400000_core_users' },
    ]);
    expect((await pool.query("SELECT to_regclass('public.users') AS name")).rows[0].name).toBe('users');
    await migrate('down');
    expect((await pool.query('SELECT count(*) FROM pgmigrations')).rows[0].count).toBe('1');
    expect((await pool.query("SELECT to_regclass('public.users') AS name")).rows[0].name).toBeNull();
    await migrate('up');
    expect((await pool.query('SELECT count(*) FROM pgmigrations')).rows[0].count).toBe('2');
  }, 30_000);

  it('stores identity with generated UUIDs, timestamps and optional profile fields', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query("INSERT INTO users (email) VALUES ('identity@example.test'), ('second@example.test') RETURNING *");
      expect(rows[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(rows[0].id).not.toBe(rows[1].id);
      expect(rows[0].created_at).toBeInstanceOf(Date);
      expect(rows[0].updated_at).toEqual(rows[0].created_at);
      expect(rows[0].password_hash).toBeNull();
      expect(rows[0].display_name).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects case-insensitive duplicate email addresses', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO users (email) VALUES ('Unique@example.test')");
      await expect(client.query("INSERT INTO users (email) VALUES ('unique@example.test')")).rejects.toMatchObject({ code: '23505' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it.each([null, '', 'missing-at', ' a@example.test', 'a b@example.test', 'a@@example.test', `${'a'.repeat(250)}@example.test`])('rejects invalid identity email: %s', async (email) => {
    await expect(pool.query('INSERT INTO users (email) VALUES ($1)', [email])).rejects.toMatchObject({ code: email === null ? '23502' : '23514' });
  });

  it.each([
    { hash: '', name: 'Tester' },
    { hash: '   ', name: 'Tester' },
    { hash: null, name: '' },
    { hash: null, name: '   ' },
    { hash: null, name: 'x'.repeat(121) },
  ])('rejects empty credential hashes and invalid profile names: %j', async ({ hash, name }) => {
    await expect(pool.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)', ['invalid-profile@example.test', hash, name])).rejects.toMatchObject({ code: '23514' });
  });

  it('preserves existing user data when migrations are rerun', async () => {
    const { rows } = await pool.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id', ['retained@example.test', 'test-only-hash', 'Test Participant']);
    try {
      await migrate('up');
      const saved = await pool.query('SELECT email, password_hash, display_name FROM users WHERE id = $1', [rows[0].id]);
      expect(saved.rows).toEqual([{ email: 'retained@example.test', password_hash: 'test-only-hash', display_name: 'Test Participant' }]);
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [rows[0].id]);
    }
  });

  it('rolls back DDL and history when a migration fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tedix-migration-test-'));
    try {
      await writeFile(join(dir, '1789065700000_failure.cjs'), "exports.up = pgm => { pgm.sql('CREATE TABLE migration_failure_probe (id int); SELECT * FROM missing_migration_probe;'); };\n");
      await expect(runner({
        databaseUrl: databaseUrl!, dir, direction: 'up', migrationsTable: 'failure_test_migrations',
        checkOrder: true, singleTransaction: true,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      })).rejects.toThrow();
      expect((await pool.query("SELECT to_regclass('public.migration_failure_probe') AS name")).rows[0].name).toBeNull();
      const history = (await pool.query("SELECT to_regclass('public.failure_test_migrations') AS name")).rows[0].name;
      if (history) expect((await pool.query('SELECT count(*) FROM failure_test_migrations')).rows[0].count).toBe('0');
    } finally {
      await pool.query('DROP TABLE IF EXISTS failure_test_migrations');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks real PostgreSQL readiness', async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    try {
      const response = await request(createApp()).get('/api/health/ready').expect(200);
      expect(response.body).toEqual({ status: 'ok', database: 'up' });
    } finally {
      await disconnectPostgres();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it('fails the compiled startup and migration command safely when configuration is missing', async () => {
    const invalidEnv = { ...env, DATABASE_URL: '' };
    for (const args of [['dist/server.js'], ['dist/db/migrate.js', 'up']]) {
      await expect(exec(process.execPath, args, { cwd: root, env: invalidEnv, timeout: 10_000 })).rejects.toMatchObject({ code: 1 });
    }
  });

  it.skipIf(process.platform === 'win32')('starts the compiled server and closes PostgreSQL on SIGTERM', async () => {
    const child = spawn(process.execPath, ['dist/server.js'], {
      cwd: root, env: { ...env, API_HOST: '127.0.0.1', API_PORT: '43179' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Startup timed out')), 10_000);
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('Exited before listening')); });
        child.stdout.on('data', (data: Buffer) => {
          if (data.toString().includes('API listening')) { clearTimeout(timeout); resolve(); }
        });
      });
      const response = await fetch('http://127.0.0.1:43179/api/health/ready');
      expect(response.status).toBe(200);
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      expect(await exited).toEqual([0, null]);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 20_000);
});
