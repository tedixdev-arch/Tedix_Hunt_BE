import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

// Only create/drop a fresh database; never use DATABASE_URL or reset a supplied schema.
const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `application_credentials_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;

suite('public application credentials against PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let pool: Pool | undefined;
  let created = false;
  let creators: typeof import('./CreatorApplication.js');
  let organizers: typeof import('./OrganizerApplication.js');
  let admins: typeof import('./AdminProvisioning.js');
  let professionals: typeof import('./ProfessionalProvisioning.js');
  let app: ReturnType<typeof import('../app.js').createApp>;
  const passwordHash = 'disposable-application-hash';
  const activatedHash = 'disposable-activation-hash';
  const digest = (token: string) => createHash('sha256').update(token).digest('hex');

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(testUrl!);
    url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const filename of (await readdir(directory)).filter((name) => /^\d{3}_.*\.ts$/.test(name)).sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js');
    environment.databaseUrl = url.toString();
    pool = (await import('../lib/postgres.js')).pool;
    creators = await import('./CreatorApplication.js');
    organizers = await import('./OrganizerApplication.js');
    admins = await import('./AdminProvisioning.js');
    professionals = await import('./ProfessionalProvisioning.js');
    app = (await import('../app.js')).createApp();
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  const input = (email: string) => ({
    name: 'Disposable D01', email, passwordHash, organizationName: 'Disposable D01',
    organizationType: 'school' as const, reason: 'Security regression', phone: null,
  });
  const kinds = ['creator', 'organizer'] as const;
  const apply = (kind: typeof kinds[number], email: string) => kind === 'creator'
    ? creators.CreatorApplications.create(input(email)) : organizers.OrganizerApplications.create(input(email));
  const conflict = (kind: typeof kinds[number]) => kind === 'creator'
    ? creators.CreatorApplicationIdentityConflictError : organizers.OrganizerApplicationIdentityConflictError;
  const fixture = async (roles: string[], options: { password?: string; status?: string; guest?: boolean; expired?: boolean } = {}) => {
    const email = `d01-${randomUUID()}@example.invalid`;
    const user = (await db.query(
      `INSERT INTO users (email, name, role, password_hash, account_status, is_guest)
       VALUES ($1, 'Disposable D01', 'participant', $2, $3, $4) RETURNING *`,
      [email, options.password ?? null, options.status ?? 'active', options.guest ?? false],
    )).rows[0];
    for (const role of roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [user.id, role]);
    const token = randomUUID();
    const purpose = `${roles.includes('admin') ? 'admin' : roles.includes('organizer') ? 'organizer' : 'creator'}_activation`;
    await db.query(
      `INSERT INTO professional_activation_tokens (user_id, token_hash, purpose, expires_at, created_by)
       VALUES ($1, $2, $3, now() + $4::interval, $1)`,
      [user.id, digest(token), purpose, options.expired ? '-1 hour' : '1 hour'],
    );
    await db.query("INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [user.id, randomUUID()]);
    return { ...user, token, purpose };
  };
  const snapshot = async (id: string) => {
    const tables = ['users', 'user_roles', 'creator_applications', 'organizer_applications', 'professional_activation_tokens', 'refresh_tokens'];
    return Promise.all(tables.map(async (table) => (await db.query(
      `SELECT * FROM ${table} WHERE ${table === 'users' ? 'id' : 'user_id'} = $1 ORDER BY 1`, [id],
    )).rows));
  };
  const activate = (user: { token: string; purpose: string }) => user.purpose === 'admin_activation'
    ? admins.AdminProvisioning.activate(digest(user.token), activatedHash)
    : professionals.ProfessionalProvisioning.activate(user.purpose === 'organizer_activation' ? 'organizer' : 'creator', digest(user.token), activatedHash);

  for (const kind of kinds) {
    it.each([
      { label: 'invited Admin', roles: ['admin'] },
      { label: 'Organizer', roles: ['organizer'] },
      { label: 'Creator', roles: ['creator'] },
      { label: 'mixed roles', roles: ['admin', 'organizer', 'creator'] },
      { label: 'expired invitation', roles: ['admin'], expired: true },
      { label: 'blocked', roles: ['admin'], status: 'blocked', password: 'existing' },
      { label: 'retired', roles: ['admin'], status: 'retired', password: 'existing' },
      { label: 'guest', roles: ['participant'], guest: true, password: 'existing' },
    ])(`${kind}: rejects $label with safe HTTP conflict and zero changes`, async (scenario) => {
      const user = await fixture(scenario.roles, scenario);
      const before = await snapshot(user.id);
      await expect(apply(kind, ` ${user.email.toUpperCase()} `)).rejects.toBeInstanceOf(conflict(kind));
      const response = await request(app).post(`/api/${kind}-applications`).send({
        ...input(` ${user.email.toUpperCase()} `), passwordHash: undefined,
        password: 'Disposable123!', confirmPassword: 'Disposable123!',
        ...(kind === 'creator' ? { organizationName: undefined, organizationType: undefined, reason: undefined, phone: undefined } : {}),
      }).expect(409);
      expect(response.body).toEqual({ error: `${kind}_application_conflict` });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await snapshot(user.id)).toEqual(before);
      expect((await db.query('SELECT id FROM users WHERE email = $1', [user.email])).rows).toHaveLength(1);
    });

    it(`${kind}: registers a new pending applicant without capability or invitation`, async () => {
      const email = `new-${randomUUID()}@example.invalid`;
      const application = await apply(kind, email);
      expect(application.status).toBe('pending');
      const user = (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];
      expect(user.password_hash).toBe(passwordHash);
      const state = await snapshot(user.id);
      expect(state[1]).toEqual([]);
      expect(state[4]).toEqual([]);
      expect(state[5]).toEqual([]);
    });

    it(`${kind}: preserves established passwords, roles, invitations and sessions`, async () => {
      const user = await fixture(['participant', 'admin', 'organizer'], { password: 'existing' });
      const before = await snapshot(user.id);
      await apply(kind, user.email);
      const after = await snapshot(user.id);
      for (const index of [0, 1, 4, 5]) expect(after[index]).toEqual(before[index]);
    });

    it(`${kind}: rolls back new identity when application insert fails`, async () => {
      const email = `rollback-${randomUUID()}@example.invalid`;
      const invalid = { ...input(email), name: null as unknown as string };
      await expect(kind === 'creator' ? creators.CreatorApplications.create(invalid)
        : organizers.OrganizerApplications.create(invalid)).rejects.toMatchObject({ code: '23502' });
      expect((await db.query('SELECT id FROM users WHERE email = $1', [email])).rows).toEqual([]);
    });

    it(`${kind}: concurrent normalized registrations share one identity and preserve its first password`, async () => {
      const email = `concurrent-${randomUUID()}@example.invalid`;
      const results = await Promise.allSettled([apply(kind, email), apply(kind, ` ${email.toUpperCase()} `)]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
      const users = (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows;
      expect(users).toHaveLength(1);
      expect(users[0].password_hash).toBe(passwordHash);
    });

    for (const role of ['admin', 'organizer', 'creator']) {
      for (const first of ['application', 'activation']) {
        it(`${kind}: ${role} activation racing with ${first} first preserves ownership`, async () => {
          const user = await fixture([role]);
          const blocker = await db.connect();
          let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
          try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
            const startApplication = () => Promise.allSettled([apply(kind, user.email)]);
            const startActivation = () => Promise.allSettled([activate(user)]);
            const firstRequest = first === 'application' ? startApplication() : startActivation();
            pending = firstRequest;
            // Observe the real lock wait before starting the other request. This forces
            // both lock orderings without timing guesses or mocked persistence.
            const waitForBlocked = async (count: number) => {
              const deadline = Date.now() + 5000;
              while (Date.now() < deadline) {
                const result = await db.query(
                  `SELECT count(*)::int AS count FROM pg_stat_activity
                   WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`, [databaseName],
                );
                if (result.rows[0].count >= count) return;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              throw new Error('Expected application/activation lock wait');
            };
            await waitForBlocked(1);
            const secondRequest = first === 'application' ? startActivation() : startApplication();
            pending = Promise.all([firstRequest, secondRequest]).then((results) => results.flat());
            await waitForBlocked(2);
            await blocker.query('COMMIT');
            const results = await pending;
            const activation = results[first === 'activation' ? 0 : 1];
            expect(activation.status).toBe('fulfilled');
            if (activation.status === 'fulfilled') expect(activation.value).toMatchObject({ id: user.id });
            const application = results[first === 'application' ? 0 : 1];
            if (first === 'application' || (kind === 'creator' && role === 'creator')) {
              expect(application.status).toBe('rejected');
              if (application.status === 'rejected') expect(application.reason).toBeInstanceOf(conflict(kind));
              expect((await snapshot(user.id))[kind === 'creator' ? 2 : 3]).toEqual([]);
            } else expect(application.status).toBe('fulfilled');
            expect((await db.query('SELECT password_hash FROM users WHERE id = $1', [user.id])).rows[0].password_hash).toBe(activatedHash);
            await expect(activate(user)).resolves.toBeNull();
            expect((await db.query('SELECT role FROM user_roles WHERE user_id = $1', [user.id])).rows).toEqual([{ role }]);
            expect((await snapshot(user.id))[5]).toHaveLength(1);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            await pending;
          }
        });
      }
    }
  }

  it.each(['admin', 'organizer', 'creator'])('legitimate %s activation survives rejected applications exactly once', async (role) => {
    const user = await fixture([role, 'participant']);
    for (const kind of kinds) await expect(apply(kind, user.email)).rejects.toBeInstanceOf(conflict(kind));
    await expect(activate(user)).resolves.toMatchObject({ id: user.id, roles: expect.arrayContaining([role, 'participant']) });
    await expect(activate(user)).resolves.toBeNull();
  });
});
