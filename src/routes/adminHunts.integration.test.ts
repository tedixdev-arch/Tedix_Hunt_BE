import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `admin_hunts_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;

type Actor = { id: string; auth: string };
suite('Admin Hunt management against disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let applicationPool: Pool | undefined;
  let created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  let platformAdmin: Actor, organizer: Actor, otherOrganizer: Actor, player: Actor;
  let orgA: string, orgB: string;
  const hunts: Record<string, string> = {};

  const actor = async (roles: string[], name: string): Promise<Actor> => {
    const id = (await db.query(`INSERT INTO users (email, role, name) VALUES ($1, 'participant', $2) RETURNING id`,
      [`${name.toLowerCase().replace(/\W+/g, '.')}.${randomUUID().slice(0, 6)}@example.invalid`, name])).rows[0].id;
    for (const role of roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, role]);
    return { id, auth: `Bearer ${signJwt({ sub: id, type: 'access', role: 'participant' })}` };
  };
  const get = (path: string, who: Actor | null = platformAdmin) => { const r = request(app).get(path); return who ? r.set('Authorization', who.auth) : r; };
  const post = (path: string, body: object, who: Actor | null = platformAdmin) => { const r = request(app).post(path).send(body); return who ? r.set('Authorization', who.auth) : r; };
  const hunt = async (organizationId: string, owner: Actor, name: string, status: string, extra: Record<string, unknown> = {}) => {
    const id = (await db.query(`INSERT INTO hunts (organization_id, created_by_user_id, name, status, city, country, start_date, start_time, timezone,
        duration_minutes, capacity, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'10:00','Europe/Bucharest',90,$8,$9) RETURNING id`,
      [organizationId, owner.id, name, status, extra.city ?? 'Cluj-Napoca', extra.country ?? 'Romania', extra.startDate ?? '2027-05-01',
        extra.capacity ?? 30, extra.createdAt ?? new Date()])).rows[0].id;
    await db.query(`INSERT INTO hunt_roles (hunt_id, user_id, role) VALUES ($1,$2,'organizer')`, [id, owner.id]);
    return id as string;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 150));

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name)).sort()) {
        migrations.push((await import(new URL(filename, directory).href)).default);
      }
      await runMigrations(client, migrations);
    } finally { client.release(); }
    process.env.AUDIT_TRAIL = 'on';
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    applicationPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); signJwt = (await import('../lib/jwt.js')).signJwt;
    platformAdmin = await actor(['admin'], 'Platform Admin'); organizer = await actor(['organizer'], 'Olga Organizer');
    otherOrganizer = await actor(['organizer'], 'Otto Other'); player = await actor(['participant'], 'Pat Player');
    orgA = (await db.query(`INSERT INTO organizations(name, owner_id) VALUES ('Alpha School', $1) RETURNING id`, [organizer.id])).rows[0].id;
    orgB = (await db.query(`INSERT INTO organizations(name, owner_id, independent) VALUES ('Otto Personal', $1, true) RETURNING id`, [otherOrganizer.id])).rows[0].id;
    await db.query('INSERT INTO organization_members VALUES ($1,$2),($3,$4)', [orgA, organizer.id, orgB, otherOrganizer.id]);
    hunts.draft = await hunt(orgA, organizer, 'Draft trail', 'draft', { createdAt: '2026-01-01T10:00:00Z' });
    hunts.published = await hunt(orgA, organizer, 'Published "quote", trail', 'published', { createdAt: '2026-02-01T10:00:00Z' });
    hunts.active = await hunt(orgA, organizer, 'Active trail', 'active', { createdAt: '2026-03-01T10:00:00Z', capacity: 40 });
    hunts.paused = await hunt(orgB, otherOrganizer, 'Paused Brasov', 'paused', { city: 'Brasov', createdAt: '2026-04-01T10:00:00Z' });
    hunts.finished = await hunt(orgB, otherOrganizer, 'Finished Iasi', 'finished', { city: 'Iasi', country: 'Moldova', createdAt: '2026-05-01T10:00:00Z' });
    hunts.cancelled = await hunt(orgA, organizer, '=cmd cancelled', 'cancelled', { createdAt: '2026-06-01T10:00:00Z' });
    // Two active players (one finished) and one open + one resolved help request on the active Hunt.
    const p1 = (await db.query(`INSERT INTO hunt_participants (hunt_id,user_id,started_at) VALUES ($1,$2,now()) RETURNING id`, [hunts.active, player.id])).rows[0].id;
    const p2 = (await db.query(`INSERT INTO hunt_participants (hunt_id,user_id,started_at,finished_at) VALUES ($1,$2,now(),now()) RETURNING id`, [hunts.active, platformAdmin.id])).rows[0].id;
    await db.query(`INSERT INTO hunt_help_requests (hunt_id,participant_id,kind,message) VALUES ($1,$2,'help','Lost near the river')`, [hunts.active, p1]);
    await db.query(`INSERT INTO hunt_help_requests (hunt_id,participant_id,kind,status,resolved_at) VALUES ($1,$2,'emergency','resolved',now())`, [hunts.active, p2]);
  }, 30_000);
  afterAll(async () => {
    delete process.env.AUDIT_TRAIL;
    await applicationPool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it('enforces admin authorization on every admin Hunt endpoint', async () => {
    for (const path of ['/api/admin/hunts', `/api/admin/hunts/${hunts.active}`, `/api/admin/hunts/${hunts.active}/history`, '/api/admin/hunts/export', '/api/admin/hunts/filters']) {
      await get(path, null).expect(401);
      await get(path, organizer).expect(403);
    }
    await post(`/api/admin/hunts/${hunts.active}/lifecycle`, { action: 'pause', reason: 'Organizer asked' }, organizer).expect(403);
    await post(`/api/admin/hunts/${hunts.published}/access`, {}, organizer).expect(403);
    // Organizer ownership checks are unchanged: another organizer cannot read or manage this Hunt.
    await get(`/api/hunts/${hunts.active}`, otherOrganizer).expect(403);
    await post(`/api/hunts/${hunts.active}/pause`, {}, otherOrganizer).expect(403);
  });

  it('lists every organization with search, filters, sorting, pagination and live counts', async () => {
    const all = (await get('/api/admin/hunts').expect(200)).body;
    expect(all.total).toBe(6); expect(all.page).toBe(1); expect(all.pageSize).toBe(25);
    expect(all.hunts.map((h: any) => h.name)[0]).toBe('=cmd cancelled');
    const active = all.hunts.find((h: any) => h.id === hunts.active);
    expect(active).toMatchObject({ participants: 2, activeParticipants: 1, finished: 1, openAlerts: 1, capacity: 40, durationMinutes: 90,
      organization: { name: 'Alpha School', independent: false }, organizer: { name: 'Olga Organizer' } });
    expect(all.hunts.find((h: any) => h.id === hunts.paused).organization.independent).toBe(true);

    const q = async (query: string) => (await get(`/api/admin/hunts?${query}`).expect(200)).body;
    expect((await q('q=otto')).hunts.map((h: any) => h.name).sort()).toEqual(['Finished Iasi', 'Paused Brasov']);
    expect((await q('q=brasov')).total).toBe(1);
    expect((await q('q=moldova')).total).toBe(1);
    expect((await q(`q=${encodeURIComponent(organizer.id.slice(0, 4))}`)).total).toBe(0);
    expect((await q('q=%25')).total).toBe(0);
    expect((await q('status=draft')).hunts.map((h: any) => h.id)).toEqual([hunts.draft]);
    expect((await q(`organizationId=${orgB}`)).total).toBe(2);
    expect((await q(`organizerId=${organizer.id}`)).total).toBe(4);
    expect((await q('createdFrom=2026-03-01&createdTo=2026-04-01')).total).toBe(2);
    // Name sorting follows the database collation; punctuation ('=cmd …') ranks differently on Windows and Linux,
    // so assert the order of the letter-only names, which every collation agrees on.
    const letters = (rows: any[]) => rows.map(h => h.name).filter((n: string) => /^[A-Za-z]/.test(n));
    const byName = ['Active trail', 'Draft trail', 'Finished Iasi', 'Paused Brasov', 'Published "quote", trail'];
    expect(letters((await q('sort=name&order=asc')).hunts)).toEqual(byName);
    expect(letters((await q('sort=name&order=desc')).hunts)).toEqual([...byName].reverse());
    const page2 = await q('pageSize=10&page=1&sort=created&order=asc');
    expect(page2.hunts[0].id).toBe(hunts.draft);
    const tiny = await q('pageSize=10&page=2');
    expect(tiny).toMatchObject({ total: 6, page: 2, hunts: [] });
    for (const bad of ['pageSize=7', 'page=0', 'status=bogus', 'sort=evil', 'organizationId=x', 'createdFrom=2026-13-40', 'unknown=1'])
      await get(`/api/admin/hunts?${bad}`).expect(400);
    const filters = (await get('/api/admin/hunts/filters').expect(200)).body;
    expect(filters.organizations.map((o: any) => o.name)).toEqual(['Alpha School', 'Otto Personal']);
  });

  it('exports the filtered list as safe CSV', async () => {
    const out = (await get('/api/admin/hunts/export?organizationId=' + orgA).expect(200)).body;
    expect(out.rows).toBe(4); expect(out.filename).toMatch(/^tedixhunt-hunts-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = out.csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Organizer email'); expect(lines).toHaveLength(5);
    expect(out.csv).toContain('"Published ""quote"", trail"');
    expect(out.csv).toContain("'=cmd cancelled");
    expect(out.csv).not.toContain('Paused Brasov');
  });

  it('returns full detail including access code, counts, readiness and allowed actions', async () => {
    const detail = (await get(`/api/admin/hunts/${hunts.active}`).expect(200)).body;
    expect(detail).toMatchObject({ id: hunts.active, status: 'active', participants: 2, activeParticipants: 1, finished: 1,
      helpRequests: { open: 1, resolved: 1 }, allowedActions: ['pause', 'cancel', 'finish'], readiness: null,
      organizer: { id: organizer.id }, organization: { id: orgA } });
    expect(detail.hunt).toMatchObject({ id: hunts.active, accessCode: null, durationMinutes: 90 });
    const draft = (await get(`/api/admin/hunts/${hunts.draft}`).expect(200)).body;
    expect(draft.readiness.ready).toBe(false);
    expect(draft.readiness.issues.map((i: any) => i.message)).toEqual(expect.arrayContaining(['Add a local contact', 'Select a Hunt template']));
    expect(draft.allowedActions).toEqual(['publish', 'cancel']);
    await get(`/api/admin/hunts/${randomUUID()}`).expect(404);
    await get('/api/admin/hunts/not-a-uuid').expect(404);

    const access = (await post(`/api/admin/hunts/${hunts.active}/access`, {}).expect(200)).body;
    expect(access.code).toMatch(/\S+/);
    expect((await get(`/api/admin/hunts/${hunts.active}`).expect(200)).body.hunt.accessCode).toBe(access.code);
    await post(`/api/admin/hunts/${hunts.draft}/access`, {}).expect(409, { error: 'invalid_hunt_state' });
  });

  it('applies lifecycle overrides with a reason, the same transition rules, and one audit event each', async () => {
    const path = `/api/admin/hunts/${hunts.active}/lifecycle`;
    await post(path, { action: 'pause' }).expect(400);
    await post(path, { action: 'pause', reason: ' ' }).expect(400, { error: 'reason_required', message: 'Give a reason of 3 to 500 characters.' });
    await post(path, { action: 'explode', reason: 'Testing' }).expect(400);
    const invalid = await post(path, { action: 'resume', reason: 'Testing invalid' }).expect(409);
    expect(invalid.body).toMatchObject({ error: 'invalid_transition', currentStatus: 'active', allowedActions: ['pause', 'cancel', 'finish'] });
    expect((await post(path, { action: 'pause', reason: 'Storm warning' }).expect(200)).body.status).toBe('paused');
    expect((await post(path, { action: 'resume', reason: 'Storm passed' }).expect(200)).body.status).toBe('active');
    expect((await post(path, { action: 'finish', reason: 'Organizer unreachable' }).expect(200)).body.status).toBe('finished');
    await post(path, { action: 'cancel', reason: 'Too late' }).expect(409);
    await post(`/api/admin/hunts/${hunts.published}/lifecycle`, { action: 'start', reason: 'Organizer phone died' }).expect(200);
    await post(`/api/admin/hunts/${hunts.draft}/lifecycle`, { action: 'publish', reason: 'Try publish' }).expect(422);

    const overrides = (await db.query(`SELECT actor_user_id, details FROM audit_events WHERE action='hunt.admin_override' AND target_id=$1 ORDER BY occurred_at`, [hunts.active])).rows;
    expect(overrides.map(r => [r.details.previousStatus, r.details.newStatus, r.details.reason])).toEqual([
      ['active', 'paused', 'Storm warning'], ['paused', 'active', 'Storm passed'], ['active', 'finished', 'Organizer unreachable']]);
    expect(overrides.every(r => r.actor_user_id === platformAdmin.id && r.details.override === true)).toBe(true);
    const detail = (await get(`/api/admin/hunts/${hunts.active}`).expect(200)).body;
    expect(detail.endedAt).not.toBeNull();
    expect((await get(`/api/admin/hunts/${hunts.published}`).expect(200)).body.startedAt).not.toBeNull();
  });

  it('shows Hunt history including organizer actions, and admin can resolve alerts and filter them by Hunt', async () => {
    // Organizer workflow still works and is audited.
    await post(`/api/hunts/${hunts.paused}/resume`, {}, otherOrganizer).expect(200);
    await settle();
    const history = (await get(`/api/admin/hunts/${hunts.paused}/history`).expect(200)).body.events;
    expect(history[0]).toMatchObject({ action: 'hunt.lifecycle', details: { transition: 'resume', newStatus: 'active' }, actor: { userId: otherOrganizer.id } });
    const alerts = (await get(`/api/admin/alerts?huntId=${hunts.active}`).expect(200)).body.alerts;
    expect(alerts).toHaveLength(2); expect(alerts[0].status).toBe('open');
    expect((await get(`/api/admin/alerts?huntId=${hunts.paused}`).expect(200)).body.alerts).toEqual([]);
    await get('/api/admin/alerts?huntId=bad').expect(400);
    await post(`/api/hunts/${hunts.active}/help-requests/${alerts[0].id}/resolve`, {}).expect(200);
  });
});
