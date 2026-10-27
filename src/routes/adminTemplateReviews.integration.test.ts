import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

// Create/drop only this unique disposable database; never reset the supplied database.
const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `d05_${randomUUID().replaceAll('-', '')}`;
const suite = testUrl ? describe : describe.skip;
const content = {
  displayName: 'Disposable D05 trail', theme: 'Explore', mission: { name: 'Review' },
  configuration: { normalCheckpointCount: 1,
    checkpointPositions: [{ checkpointNumber: 1, name: 'Square', latitude: 46.77, longitude: 23.62, radiusMeters: 30 }],
    finishPoint: { name: 'Finish', latitude: 46.78, longitude: 23.63, radiusMeters: 5 } },
  checkpoints: [{ id: 'one', checkpoint: 1 }, { id: 'finish', role: 'terminal', kind: 'shared-final-key', teamKind: 'shared-final-key', navigationMode: 'none' }],
};

suite('independent Template review against PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool;
  let pool: Pool | undefined;
  let created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  let model: typeof import('../models/HuntTemplate.js');
  let users: typeof import('../models/User.js');
  let owner: Identity;
  let reviewer: Identity;
  let combined: Identity;
  type Identity = { id: string; auth: string };
  type Template = { id: string; key: string };
  const identity = async (roles: string[], options: { guest?: boolean; status?: string; primary?: string } = {}): Promise<Identity> => {
    const id = (await db.query(`INSERT INTO users (email, name, role, is_guest, account_status) VALUES ($1, 'Disposable reviewer', $2, $3, $4) RETURNING id`,
      [`d05-${randomUUID()}@example.invalid`, options.primary ?? 'participant', options.guest ?? false, options.status ?? 'active'])).rows[0].id;
    for (const role of roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [id, role]);
    return { id, auth: `Bearer ${signJwt({ sub: id, type: 'access', role: 'admin' })}` };
  };
  const fixture = async (creator = owner, status = 'submitted'): Promise<Template> => {
    const key = `d05-${randomUUID()}`;
    const template = await model.HuntTemplates.create({ key, origin: 'creator', createdByUserId: creator.id, status: 'draft' });
    for (const version of [1, 2]) await model.HuntTemplates.createVersion({ templateId: template.id, version,
      origin: 'creator', createdByUserId: creator.id, content: { ...content, key, version } });
    if (status !== 'draft') await db.query('UPDATE hunt_templates SET status = $2, submitted_version = 1 WHERE id = $1', [template.id, status]);
    return template;
  };
  const snapshot = async (t: Template) => ({
    template: (await db.query('SELECT * FROM hunt_templates WHERE id = $1', [t.id])).rows,
    versions: (await db.query('SELECT * FROM hunt_template_versions WHERE template_id = $1 ORDER BY version', [t.id])).rows,
    reviews: (await db.query('SELECT * FROM hunt_template_reviews WHERE template_id = $1', [t.id])).rows,
  });
  const decide = (t: Template, actor = reviewer, decision = 'approve') => request(app)
    .post(`/api/admin/templates/review/${t.key}/${decision}`).set('Authorization', actor.auth);
  const evidence = async (t: Template, actor: Identity, decision: string, since: number) => {
    const rows = (await snapshot(t)).reviews;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ template_id: t.id, version: 1, reviewer_user_id: actor.id, decision, decided_at: expect.any(Date) });
    expect(rows[0].decided_at.getTime()).toBeGreaterThanOrEqual(since - 1000);
    expect(rows[0].decided_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  };
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const filename of (await readdir(directory)).filter(name => /^\d{3}_.*\.ts$/.test(name)).sort()) migrations.push((await import(new URL(filename, directory).href)).default);
      await runMigrations(client, migrations);
    } finally { client.release(); }
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    pool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); signJwt = (await import('../lib/jwt.js')).signJwt;
    model = await import('../models/HuntTemplate.js'); users = await import('../models/User.js');
    owner = await identity(['creator']); reviewer = await identity(['admin']); combined = await identity(['creator', 'admin']);
  }, 30_000);
  afterAll(async () => {
    await pool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it.each([
    { label: 'Creator-only', roles: ['creator'] },
    { label: 'Participant-only', roles: ['participant'] },
    { label: 'Organizer-only', roles: ['organizer'] },
    { label: 'guest with Admin row', roles: ['admin'], guest: true },
    { label: 'legacy Admin without capability', roles: [], primary: 'admin' },
    { label: 'blocked Admin', roles: ['admin'], status: 'blocked' },
    { label: 'retired Admin', roles: ['admin'], status: 'retired' },
  ])('denies $label before decision and leaves no partial records', async scenario => {
    const actor = await identity(scenario.roles, scenario); const t = await fixture(); const before = await snapshot(t);
    for (const decision of ['approve', 'request-changes']) await decide(t, actor, decision)
      .expect(scenario.status ? 401 : 403, { error: scenario.status ? 'unauthorized' : 'forbidden' });
    expect(await snapshot(t)).toEqual(before);
  });
  it('denies missing/invalid authentication and rechecks revoked capability with the same token', async () => {
    const t = await fixture(); const before = await snapshot(t);
    for (const decision of ['approve', 'request-changes']) {
      await request(app).post(`/api/admin/templates/review/${t.key}/${decision}`).expect(401, { error: 'unauthorized' });
      await decide(t, { id: '', auth: 'Bearer invalid' }, decision).expect(401, { error: 'unauthorized' });
    }
    const actor = await identity(['admin']);
    await db.query('DELETE FROM user_roles WHERE user_id = $1', [actor.id]);
    await decide(t, actor).expect(403, { error: 'forbidden' });
    expect(await snapshot(t)).toEqual(before);
  });
  it.each(['Admin-only', 'combined-role Admin'])('%s approves another Creator and persists exact-version evidence', async label => {
    const actor = label === 'Admin-only' ? reviewer : combined; const t = await fixture(); const before = await snapshot(t); const since = Date.now();
    const review = await request(app).get(`/api/admin/templates/review/${t.key}`).set('Authorization', actor.auth).expect(200);
    expect(review.body.version).toBe(1);
    const response = await decide(t, actor).send({ reviewerUserId: owner.id, version: 2 }).expect(200);
    expect(response.body).toEqual({ ...review.body, status: 'approved' });
    const after = await snapshot(t); expect(after.versions).toEqual(before.versions);
    expect(after.template[0]).toEqual({ ...before.template[0], status: 'approved', updated_at: expect.any(Date) });
    await evidence(t, actor, 'approved', since);
    expect(await model.HuntTemplates.findApprovedByKeyWithLatestVersion(t.key)).toEqual({ key: t.key, version: 1, content: before.versions[0].content });
  });
  it('rejects combined-role self-approval atomically including spoofed actor/version inputs', async () => {
    const t = await fixture(combined); const before = await snapshot(t);
    await decide(t, combined).send({ reviewerUserId: reviewer.id, version: 2 }).expect(403, { error: 'template_self_approval_forbidden' });
    expect(await snapshot(t)).toEqual(before);
    await expect(model.HuntTemplates.approveSubmittedCreator(t.key, combined.id)).rejects.toBeInstanceOf(model.HuntTemplateSelfApprovalError);
    expect(await snapshot(t)).toEqual(before);
    await decide(t).expect(200); await evidence(t, reviewer, 'approved', Date.now());
  });
  it.each([false, true])('records request-changes provenance (self=%s), with no route back to approval', async self => {
    const t = await fixture(self ? combined : owner); const actor = self ? combined : reviewer; const before = await snapshot(t); const since = Date.now();
    await decide(t, actor, 'request-changes').expect(200);
    const after = await snapshot(t); expect(after.versions).toEqual(before.versions);
    expect(after.template[0]).toEqual({ ...before.template[0], status: 'changes_requested', updated_at: expect.any(Date) });
    await evidence(t, actor, 'changes_requested', since);
    for (const next of [actor, reviewer]) await decide(t, next).expect(409, { error: 'template_not_reviewable' });
    expect(await snapshot(t)).toEqual(after);
    // Existing FK handling preserves the history even if the Creator tries to delete it.
    await expect(model.HuntTemplates.deleteCreatorDraft(t.key, self ? combined.id : owner.id)).rejects.toBeInstanceOf(model.HuntTemplateInUseError);
    expect(await snapshot(t)).toEqual(after);
  });
  it.each(['draft', 'approved', 'changes_requested'])('rejects stale %s decisions with no partial record', async status => {
    const t = await fixture(owner, status); const before = await snapshot(t);
    for (const decision of ['approve', 'request-changes']) await decide(t, reviewer, decision).expect(409, { error: 'template_not_reviewable' });
    expect(await snapshot(t)).toEqual(before);
  });
  it('returns existing not_found errors for unknown and platform keys', async () => {
    for (const key of ['missing', 'signal-cluj-napoca']) for (const decision of ['approve', 'request-changes'])
      await decide({ id: '', key }, reviewer, decision).expect(404, { error: 'not_found' });
  });
  it('fails closed for a missing submitted pin in legacy/corrupt state', async () => {
    const t = await fixture();
    // Isolated DB only: simulate pre-constraint corruption, then restore the production constraint.
    await db.query('ALTER TABLE hunt_templates DROP CONSTRAINT hunt_templates_submitted_version_check');
    try {
      await db.query('UPDATE hunt_templates SET submitted_version = NULL WHERE id = $1', [t.id]);
      const before = await snapshot(t);
      for (const decision of ['approve', 'request-changes']) await decide(t, reviewer, decision).expect(409, { error: 'template_not_reviewable' });
      expect(await snapshot(t)).toEqual(before);
    } finally {
      await db.query('UPDATE hunt_templates SET submitted_version = 1 WHERE id = $1', [t.id]);
      await db.query("ALTER TABLE hunt_templates ADD CONSTRAINT hunt_templates_submitted_version_check CHECK (status <> 'submitted' OR submitted_version IS NOT NULL)");
    }
  });
  it('cannot replace the submitted pin through stale save/resubmit attempts', async () => {
    const t = await fixture(); const before = await snapshot(t);
    await expect(model.HuntTemplates.createCreatorVersion(t.key, { ...content, key: t.key, version: 3 }, owner.id))
      .rejects.toBeInstanceOf(model.HuntTemplateNotEditableError);
    await expect(model.HuntTemplates.submitCreatorDraft(t.key, 2, owner.id))
      .rejects.toBeInstanceOf(model.HuntTemplateNotSubmittableError);
    expect(await snapshot(t)).toEqual(before);
    await decide(t).expect(200); await evidence(t, reviewer, 'approved', Date.now());
    expect((await snapshot(t)).versions).toEqual(before.versions);
  });
  it('fails closed when the pinned version cannot be resolved in corrupt legacy data', async () => {
    const t = await fixture();
    await db.query('ALTER TABLE hunt_templates DROP CONSTRAINT hunt_templates_submitted_version_fkey');
    try {
      await db.query('UPDATE hunt_templates SET submitted_version = 999 WHERE id = $1', [t.id]);
      const before = await snapshot(t);
      for (const decision of ['approve', 'request-changes']) await decide(t, reviewer, decision).expect(409, { error: 'template_not_reviewable' });
      expect(await snapshot(t)).toEqual(before);
    } finally {
      await db.query('UPDATE hunt_templates SET submitted_version = 1 WHERE id = $1', [t.id]);
      await db.query('ALTER TABLE hunt_templates ADD CONSTRAINT hunt_templates_submitted_version_fkey FOREIGN KEY (id, submitted_version) REFERENCES hunt_template_versions(template_id, version) DEFERRABLE INITIALLY DEFERRED');
    }
  });
  it('rejects a pin to a missing version at the database boundary without partial changes', async () => {
    const t = await fixture(); const before = await snapshot(t);
    await expect(db.query('UPDATE hunt_templates SET submitted_version = 999 WHERE id = $1', [t.id])).rejects.toMatchObject({ code: '23503' });
    expect(await snapshot(t)).toEqual(before);
  });
  it.each(['approve', 'request-changes'])('serializes concurrent approval versus %s into exactly one decision', async other => {
    const t = await fixture(); const before = await snapshot(t);
    const blocker = await db.connect();
    let results: Awaited<ReturnType<typeof decide>>[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM hunt_templates WHERE id = $1 FOR UPDATE', [t.id]);
      const pending = Promise.all([decide(t, reviewer).then(r => r), decide(t, combined, other).then(r => r)]);
      try {
        // Prove both real transactions are waiting on the existing identity lock.
        await expect.poll(async () => Number((await db.query(
          `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`,
        )).rows[0].count), { timeout: 3000, interval: 10 }).toBe(2);
      } finally { await blocker.query('COMMIT'); }
      results = await pending;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const winner = results[0].status === 200 ? { actor: reviewer, decision: 'approved' } : { actor: combined, decision: other === 'approve' ? 'approved' : 'changes_requested' };
    await evidence(t, winner.actor, winner.decision, Date.now());
    const after = await snapshot(t); expect(after.versions).toEqual(before.versions);
    expect(after.template[0].status).toBe(winner.decision); expect(after.template[0].submitted_version).toBe(1);
  });
  it('rolls back the status transition when provenance insertion fails', async () => {
    const t = await fixture(); const before = await snapshot(t);
    // A genuine FK violation after the UPDATE must undo the whole transaction.
    for (const operation of [model.HuntTemplates.approveSubmittedCreator, model.HuntTemplates.requestChangesForSubmittedCreator]) {
      await expect(operation(t.key, randomUUID())).rejects.toMatchObject({ code: '23503' });
      expect(await snapshot(t)).toEqual(before);
    }
    await decide(t).expect(200);
  });
  it.each(['approve', 'request-changes'])('retains %s reviewer attribution after controlled account retirement', async decision => {
    const actor = await identity(['admin']); const t = await fixture();
    await decide(t, actor, decision).expect(200); const before = await snapshot(t);
    expect(await users.User.deleteControlled(actor.id)).toBe('retired');
    expect(await snapshot(t)).toEqual(before);
    expect((await db.query('SELECT account_status, email, name FROM users WHERE id = $1', [actor.id])).rows).toEqual([{ account_status: 'retired', email: null, name: 'Deleted user' }]);
    await decide(await fixture(), actor).expect(401, { error: 'unauthorized' });
    await expect(db.query('DELETE FROM users WHERE id = $1', [actor.id])).rejects.toMatchObject({ code: '23503' });
  });
  it('preserves existing approved Templates, versions and Hunt snapshots through migration and reviews', async () => {
    const t = await fixture(owner, 'approved'); const before = await snapshot(t);
    const org = (await db.query("INSERT INTO organizations (name, owner_id) VALUES ('D05 disposable', $1) RETURNING id", [owner.id])).rows[0].id;
    const hunt = (await db.query(`INSERT INTO hunts (organization_id, created_by_user_id, name, status, template_key, template_version, template_snapshot) VALUES ($1, $2, 'Historic hunt', 'draft', $3, 1, $4) RETURNING *`, [org, owner.id, t.key, before.versions[0].content])).rows[0];
    const client = await db.connect();
    try {
      // Transactional DDL simulates migration from the old schema and rolls back afterwards.
      await client.query('BEGIN');
      // Remove only C1's incoming reference while simulating the pre-021 schema.
      // ROLLBACK below restores the reference and all original review history.
      await client.query('ALTER TABLE hunt_templates DROP CONSTRAINT hunt_templates_source_review_fkey');
      await client.query('DROP TABLE hunt_template_reviews');
      const migration = (await import('../db/migrations/021_template_review_decisions.js')).default;
      await migration.up(client);
      expect((await client.query('SELECT * FROM hunt_templates WHERE id = $1', [t.id])).rows).toEqual(before.template);
      expect((await client.query('SELECT * FROM hunt_template_versions WHERE template_id = $1 ORDER BY version', [t.id])).rows).toEqual(before.versions);
      expect((await client.query('SELECT * FROM hunts WHERE id = $1', [hunt.id])).rows).toEqual([hunt]);
      expect((await client.query('SELECT * FROM hunt_template_reviews')).rows).toEqual([]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    // No backfill: an existing approval must not acquire invented reviewer attribution.
    expect(before.reviews).toEqual([]);
    const platformBefore = (await db.query("SELECT * FROM hunt_template_versions WHERE origin = 'platform' ORDER BY id")).rows;
    await decide(await fixture()).expect(200);
    expect(await snapshot(t)).toEqual(before);
    expect((await db.query('SELECT * FROM hunts WHERE id = $1', [hunt.id])).rows).toEqual([hunt]);
    expect((await db.query("SELECT * FROM hunt_template_versions WHERE origin = 'platform' ORDER BY id")).rows).toEqual(platformBefore);
  });
});
