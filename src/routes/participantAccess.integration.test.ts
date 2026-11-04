import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { signalClujNapocaV1 } from '../domain/templates/signalClujNapocaV1.js';
import { createSignalClujNapocaStarter } from '../domain/templates/signalClujNapocaStarter.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const name = `access_${randomUUID().replaceAll('-', '')}`;
suite('Task 5A authenticated Express and disposable PostgreSQL access foundation', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool, appPool: Pool, app: ReturnType<typeof import('../app.js').createApp>;
  let sign: typeof import('../lib/jwt.js').signJwt;
  let enroll: typeof import('../models/HuntParticipant.js').HuntParticipant.enroll;
  const actors: Record<string, string> = {};
  let org: string, hunt: string, other: string, legacy: string;
  let databaseUrl: string;
  let points: string[];
  const auth = (who = 'participant') => `Bearer ${sign({ sub: actors[who], type: 'access' })}`;
  const get = (h = hunt, who = 'participant') => request(app).get(`/api/hunts/${h}/participants/me`).set('Authorization', auth(who));
  const rejoin = (body: object = {}, h = hunt, who = 'participant') => request(app).post(`/api/hunts/${h}/participants/enroll`).set('Authorization', auth(who)).send(body);
  const obs = () => ({ latitude: 46, longitude: 23, accuracyMeters: 1, observedAt: new Date().toISOString() });
  const verify = (cp = points[0], body: object = obs(), h = hunt, who = 'participant') =>
    request(app).post(`/api/hunts/${h}/checkpoints/${cp}/proximity`).set('Authorization', auth(who)).send(body);
  const context = async () => (await get().expect(200)).body;
  const state = async () => (await db.query('SELECT * FROM participant_checkpoint_access ORDER BY participant_id,checkpoint_id')).rows;
  const makeHunt = async (snapshot: object, status = 'active', code: string | null = null) => (await db.query(`INSERT INTO hunts
    (organization_id,created_by_user_id,name,status,template_key,template_version,template_snapshot,access_code,access_mode,capacity)
    VALUES($1,$2,'Historical fixture',$3,$4,1,$5,$6,'invitation_only',100) RETURNING id`,
    [org, actors.organizer, status, (snapshot as any).key, snapshot, code])).rows[0].id as string;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(testUrl!); url.pathname = `/${name}`;
    databaseUrl = url.toString();
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const filenames = (await readdir(directory)).filter(f => /^\d{3}_.*\.ts$/.test(f)).sort();
      const expectedIds = filenames.map(f => f.slice(0, -3));
      expect(expectedIds.length).toBeGreaterThan(0);
      const migrations = [];
      for (const f of filenames) migrations.push((await import(new URL(f, directory).href)).default);
      expect(await runMigrations(client, migrations)).toEqual(expectedIds);
      expect((await client.query('SELECT id FROM schema_migrations ORDER BY id')).rows.map(row => row.id)).toEqual(expectedIds);
      expect(await runMigrations(client, migrations)).toEqual([]);
    } finally { client.release(); }
    for (const who of ['participant', 'second', 'racer', 'outsider', 'organizer', 'admin', 'supervisor', 'blocked', 'retired', 'guest']) {
      actors[who] = (await db.query(`INSERT INTO users(email,role,account_status,is_guest) VALUES($1,'participant',$2,$3) RETURNING id`,
        [`${who}@access.invalid`, ['blocked','retired'].includes(who) ? who : 'active', who === 'guest'])).rows[0].id;
      await db.query('INSERT INTO user_roles VALUES($1,$2)', [actors[who], ['organizer','admin'].includes(who) ? who : 'participant']);
    }
    org = (await db.query("INSERT INTO organizations(name,owner_id) VALUES('Access test',$1) RETURNING id", [actors.organizer])).rows[0].id;
    const snapshot = createSignalClujNapocaStarter('access-route');
    Object.assign(snapshot.configuration, { checkpointPositions: Array.from({ length: 6 }, (_, i) => ({ checkpointNumber: i + 1, latitude: 46, longitude: 23, radiusMeters: i === 0 ? 5 : 20 })),
      finishPoint: { latitude: 46, longitude: 23, radiusMeters: 12 } });
    hunt = await makeHunt(snapshot, 'active', '7KPM4XQ2');
    other = await makeHunt(snapshot, 'active', '8KPM4XQ2');
    legacy = await makeHunt(signalClujNapocaV1);
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    appPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp();
    sign = (await import('../lib/jwt.js')).signJwt;
    enroll = (await import('../models/HuntParticipant.js')).HuntParticipant.enroll;
    // Trusted pre-existing membership fixture; no public invitation policy is fabricated.
    for (const who of ['participant','second','blocked','retired','guest','racer'])
      await db.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES($1,$2)', [hunt, actors[who]]);
    await db.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES($1,$2),($3,$4)', [other, actors.outsider, legacy, actors.participant]);
    for (const role of ['organizer','supervisor']) await db.query('INSERT INTO hunt_roles VALUES($1,$2,$3)', [hunt, actors[role], role]);
  }, 30000);
  afterAll(async () => {
    app?.locals.stopAbuseProtection(); await appPool?.end(); await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`); await admin.end();
  });
  it('returns the same historical membership for concurrent model rejoin without duplicates or Teams', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => enroll(hunt, actors.racer)));
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect((await db.query('SELECT count(*) FROM hunt_participants WHERE hunt_id=$1 AND user_id=$2', [hunt, actors.racer])).rows[0].count).toBe('1');
    expect((await db.query('SELECT count(*) FROM teams')).rows[0].count).toBe('0');
  });
  it('rejoins idempotently and retains stable IDs after new requests/reconnect and simultaneous initialization', async () => {
    const before = (await db.query('SELECT template_snapshot FROM hunts WHERE id=$1', [hunt])).rows[0].template_snapshot;
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => rejoin(i % 2 ? {} : { accessCode: ' 7kpm4xq2 ' })));
    expect(responses.every(r => r.status === 200)).toBe(true);
    const first = responses[0].body;
    expect(responses.every(r => JSON.stringify(r.body) === JSON.stringify(first))).toBe(true);
    points = first.checkpoints.map((c: any) => c.checkpointId);
    expect(new Set(points).size).toBe(7);
    expect(first.checkpoints.map((c: any) => c.accessState)).toEqual(['eligible_for_proximity', ...Array(6).fill('not_yet_accessible')]);
    expect(first.checkpoints.at(-1).kind).toBe('finish');
    expect(first.checkpoints.every((c: any) => !c.gameplayCompleted && !c.mayAccessGameplay)).toBe(true);
    expect((await context()).participantId).toBe(first.participantId);
    expect((await context()).checkpoints).toEqual(first.checkpoints);
    expect((await db.query('SELECT template_snapshot FROM hunts WHERE id=$1', [hunt])).rows[0].template_snapshot).toEqual(before);
    expect((await get(hunt, 'second').expect(200)).body.checkpoints.map((c: any) => c.checkpointId)).toEqual(points);
    expect(JSON.stringify(first)).not.toMatch(/correctAnswers|teamAnswer|solution|publicContributions|templateSnapshot|password/);
    expect(responses[0].headers['cache-control']).toBe('no-store');
  });
  it('admits authenticated first members and guests atomically and idempotently', async () => {
    const h = await makeHunt(createSignalClujNapocaStarter('admission'), 'published', '6KPM4XQ2');
    await db.query("UPDATE hunts SET hunt_format='solo' WHERE id=$1",[h]);
    await request(app).get('/api/hunt-access/6KPM4XQ2').expect(200);
    expect((await db.query('SELECT * FROM hunt_participants WHERE hunt_id=$1',[h])).rowCount).toBe(0);
    await rejoin({}, h, 'outsider').expect(404);
    for (const code of ['7KPM4XQ2','9KPM4XQ2']) await rejoin({ accessCode: code },h,'outsider').expect(404);
    const responses = await Promise.all(Array.from({length: 8}, () => rejoin({accessCode:'6KPM4XQ2'},h,'outsider')));
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(new Set(responses.map(r => r.body.participantId)).size).toBe(1);
    await rejoin({accessCode:'6KPM4XQ2'},h,'guest').expect(200);
    expect((await db.query('SELECT * FROM teams')).rowCount).toBe(0);
  });
  it('serializes final-seat admissions and rejects null capacity and closed lifecycles', async () => {
    const h = await makeHunt(createSignalClujNapocaStarter('capacity'), 'active', '5KPM4XQ2');
    await db.query("UPDATE hunts SET capacity=1,hunt_format='team',team_size=4 WHERE id=$1",[h]);
    const r = await Promise.all(['outsider','guest'].map(w => rejoin({accessCode:'5KPM4XQ2'},h,w)));
    expect(r.map(x=>x.status).sort()).toEqual([200,409]);
    expect((await db.query('SELECT * FROM hunt_participants WHERE hunt_id=$1',[h])).rowCount).toBe(1);
    for (const status of ['paused','draft','finished','cancelled']) {
      await db.query('UPDATE hunts SET status=$2 WHERE id=$1',[h,status]);
      await rejoin({accessCode:'5KPM4XQ2'},h,'admin').expect(409);
    }
    await db.query("UPDATE hunts SET status='active',capacity=NULL WHERE id=$1",[h]);
    await rejoin({accessCode:'5KPM4XQ2'},h,'admin').expect(409,{error:'capacity_unconfigured'});
  });
  it('restricts invitation controls and preserves rejoin after disable and rotation', async () => {
    const endpoint = `/api/hunts/${hunt}/access`;
    const supervisorRead = await request(app).get(`/api/hunts/${hunt}`).set('Authorization',auth('supervisor')).expect(200);
    expect(supervisorRead.body.accessCode).toBeNull();
    await request(app).delete(endpoint).expect(401);
    await request(app).post(endpoint+'/regenerate').expect(401);
    for (const who of ['participant','supervisor','admin']) {
      await request(app).delete(endpoint).set('Authorization',auth(who)).expect(403);
      await request(app).post(endpoint+'/regenerate').set('Authorization',auth(who)).expect(403);
    }
    await request(app).delete(endpoint).set('Authorization',auth('organizer')).expect(200);
    await rejoin({accessCode:'7KPM4XQ2'},hunt,'outsider').expect(404);
    await request(app).get('/api/hunt-access/7KPM4XQ2').expect(404);
    await rejoin().expect(200);
    const disabled = await request(app).post(endpoint).set('Authorization',auth('organizer')).expect(200);
    expect(disabled.body.enabled).toBe(false);
    const rotated = await request(app).post(endpoint+'/regenerate').set('Authorization',auth('organizer')).expect(200);
    expect(rotated.body.code).not.toBe('7KPM4XQ2');
    await rejoin({accessCode:'7KPM4XQ2'},hunt,'outsider').expect(404);
    await rejoin().expect(200);
    // Restore the fixture code for independent access tests.
    await db.query("UPDATE hunts SET access_code='7KPM4XQ2' WHERE id=$1",[hunt]);
  });
  it('rolls back new membership when checkpoint initialization fails', async () => {
    const h = await makeHunt(createSignalClujNapocaStarter('rollback'),'active','4KPM4XQ2');
    await db.query(`CREATE FUNCTION reject_access_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$`);
    await db.query('CREATE TRIGGER reject_access_fixture BEFORE INSERT ON participant_checkpoint_access FOR EACH ROW EXECUTE FUNCTION reject_access_fixture()');
    try { await rejoin({accessCode:'4KPM4XQ2'},h,'outsider').expect(500); }
    finally { await db.query('DROP TRIGGER reject_access_fixture ON participant_checkpoint_access'); await db.query('DROP FUNCTION reject_access_fixture()'); }
    expect((await db.query('SELECT * FROM hunt_participants WHERE hunt_id=$1',[h])).rowCount).toBe(0);
    expect((await db.query('SELECT * FROM hunt_checkpoint_identities WHERE hunt_id=$1',[h])).rowCount).toBe(0);
  });
  it('enforces bearer type, active identity and body allowlists', async () => {
    await request(app).get(`/api/hunts/${hunt}/participants/me`).expect(401);
    await request(app).post(`/api/hunts/${hunt}/participants/enroll`).send({ accessCode: '7KPM4XQ2' }).expect(401);
    await request(app).get(`/api/hunts/${hunt}/participants/me`).set('Authorization', `Bearer ${sign({ sub: actors.participant, type: 'refresh' })}`).expect(401);
    for (const who of ['blocked','retired']) { await get(hunt, who).expect(401); await verify(points[0], obs(), hunt, who).expect(401); }
    await rejoin({ userId: actors.second }).expect(400);
    await rejoin({ accessCode: 123 }).expect(400);
    for (const accessCode of ['invalid']) await rejoin({ accessCode }).expect(404);
    await get('not-a-uuid').expect(404);
    // Existing authenticated guest identity may rejoin; no guest is created by this transport.
    await get(hunt, 'guest').expect(200);
  });
  it('isolates Hunt membership, checkpoint UUIDs and direct future access', async () => {
    const foreign = (await get(other, 'outsider').expect(200)).body.checkpoints[0].checkpointId;
    expect(foreign).not.toBe(points[0]);
    await verify(foreign).expect(404);
    await verify(points[0], obs(), other).expect(404);
    await verify(points[0], obs(), hunt, 'outsider').expect(404);
    await verify('1').expect(404);
    const before = await state();
    for (const cp of points.slice(1)) await verify(cp).expect(409, { error: 'checkpoint_not_eligible' });
    // Pilot policy (pilot-solo-2026-11): a fresh reading outside the effective radius never grants.
    await verify(points[0], { ...obs(), latitude: 46.01 }).expect(422, { error: 'proximity_outside_radius' });
    expect(await state()).toEqual(before);
    await request(app).get(`/api/hunts/${hunt}/checkpoints/${points.at(-1)}/access`).set('Authorization', auth()).expect(200);
    await request(app).post(`/api/hunts/${hunt}/checkpoints/${points[0]}/challenges/personal/attempts`).set('Authorization', auth()).send({ response: {} }).expect(404);
  });
  it('rejects malformed GPS coordinates, timestamps, accuracy and client authority fields', async () => {
    const invalid = [
      ...[-91,91,null,'46',1e100].map(latitude => ({ ...obs(), latitude })),
      ...[-181,181,null,'23'].map(longitude => ({ ...obs(), longitude })),
      ...[-1,null,'1'].map(accuracyMeters => ({ ...obs(), accuracyMeters })),
      ...['now','2026-02-30T20:00:00.000Z','2026-10-31'].map(observedAt => ({ ...obs(), observedAt })),
      { ...obs(), completed: true }, { ...obs(), participantId: actors.second }, { ...obs(), radiusMeters: 5000 }, {},
    ];
    for (const body of invalid) await verify(points[0], body).expect(400);
    // Syntactically valid stale/future/inaccurate observations cannot grant access either.
    for (const [body, error] of [[{ ...obs(), observedAt: '2020-01-01T00:00:00.000Z' }, 'proximity_stale'], [{ ...obs(), observedAt: '2099-01-01T00:00:00.000Z' }, 'proximity_stale'], [{ ...obs(), accuracyMeters: 9999 }, 'proximity_inaccurate']] as const)
      await verify(points[0], body).expect(422, { error });
    expect((await state()).every(s => s.state !== 'proximity_verified' && s.verified_at === null)).toBe(true);
  });
  it('rechecks lifecycle on rejoin, context and proximity without granting on pause or terminal states', async () => {
    for (const status of ['published','paused','draft','finished','cancelled']) {
      await db.query('UPDATE hunts SET status=$2 WHERE id=$1', [hunt, status]);
      await rejoin().expect(['published','paused'].includes(status) ? 200 : 409);
      await get().expect(['published','paused'].includes(status) ? 200 : 409);
      await verify().expect(409);
    }
    await db.query("UPDATE hunts SET status='active' WHERE id=$1", [hunt]);
  });
  it('preserves canonical Signal historical snapshot and FinishPoint without fabricated geography', async () => {
    const r = await get(legacy).expect(200);
    expect(r.body.checkpoints).toHaveLength(7);
    expect(r.body.checkpoints.at(-1).kind).toBe('finish');
    await verify(r.body.checkpoints[0].checkpointId, obs(), legacy).expect(422, { error: 'checkpoint_geography_unavailable' });
    expect((await db.query('SELECT template_snapshot FROM hunts WHERE id=$1', [legacy])).rows[0].template_snapshot).toEqual(signalClujNapocaV1);
    expect((await get(legacy).expect(200)).body.checkpoints).toEqual(r.body.checkpoints);
  });
  it('pins Hunt snapshot/version and enforces composite foreign keys in PostgreSQL', async () => {
    await expect(db.query('UPDATE hunts SET template_version=2 WHERE id=$1', [hunt])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query("UPDATE hunts SET template_snapshot=jsonb_set(template_snapshot,'{version}','2') WHERE id=$1", [hunt])).rejects.toMatchObject({ code: '23514' });
    const p = (await context()).participantId;
    const cp = (await db.query('SELECT * FROM hunt_checkpoint_identities WHERE hunt_id=$1 LIMIT 1', [other])).rows[0];
    await expect(db.query(`INSERT INTO participant_checkpoint_access(hunt_id,participant_id,checkpoint_id,snapshot_digest,state)
      VALUES($1,$2,$3,$4,'eligible_for_proximity')`, [other, p, cp.id, cp.snapshot_digest])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query("UPDATE participant_checkpoint_access SET state='proximity_verified' WHERE participant_id=$1", [p])).rejects.toMatchObject({ code: '23514' });
  });
  it('reads durable verification evidence without treating it as gameplay completion or an enabled grant', async () => {
    const participant = (await context()).participantId;
    // Future trusted-writer fixture only: no HTTP grant, GPS trust or approved policy is claimed.
    await db.query(`UPDATE participant_checkpoint_access SET state='proximity_verified',verified_at=now(),observed_at=now(),
      accuracy_meters=1,distance_meters=0,policy_revision='fixture-only-not-approved' WHERE participant_id=$1 AND checkpoint_id=$2`, [participant, points[0]]);
    const freshApp = (await import('../app.js')).createApp();
    try {
      const r = await request(freshApp).get(`/api/hunts/${hunt}/participants/me`).set('Authorization', auth()).expect(200);
      expect(r.body.checkpoints[0]).toMatchObject({ accessState: 'proximity_verified', gameplayCompleted: false, mayAccessGameplay: true });
      expect(r.body.checkpoints[0].verifiedAt).toEqual(expect.any(String));
      expect(r.body.checkpoints[1].accessState).toBe('not_yet_accessible');
      await verify(points[1]).expect(409);
      // An existing grant is idempotent; it is never re-evaluated into a second grant.
      await verify(points[0]).expect(200);
    } finally { freshApp.locals.stopAbuseProtection(); }
  });
  it('retains Organizer and Admin authorization boundaries', async () => {
    await request(app).get(`/api/hunts/${hunt}`).set('Authorization', auth()).expect(403);
    await request(app).patch(`/api/hunts/${hunt}`).set('Authorization', auth()).send({ name: 'No' }).expect(403);
    await request(app).get(`/api/hunts/${hunt}`).set('Authorization', auth('organizer')).expect(200);
    await request(app).get('/api/admin/users').set('Authorization', auth()).expect(403);
  });

  it('denies first membership through the model, including concurrent duplicate attempts', async () => {
    const before = (await db.query('SELECT * FROM hunt_participants ORDER BY id')).rows;
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => enroll(hunt, actors.outsider)));
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 422, code: 'enrollment_policy_unresolved' });
    }
    expect((await db.query('SELECT * FROM hunt_participants ORDER BY id')).rows).toEqual(before);
  });

  it('rejects purported eligibility, membership, Team and role fields and replaced codes without writes', async () => {
    const before = (await db.query('SELECT * FROM hunt_participants ORDER BY id')).rows;
    for (const body of [{ invitation: 'claimed' }, { invitationId: randomUUID() }, { eligible: true },
      { participantId: (await context()).participantId }, { teamId: randomUUID() }, { role: 'organizer' }, { huntId: other }])
      await rejoin({ accessCode: '7KPM4XQ2', ...body }, hunt, 'outsider').expect(400);
    await db.query("UPDATE hunts SET access_code='3KPM4XQ2' WHERE id=$1", [hunt]);
    try {
      await rejoin({ accessCode: '7KPM4XQ2' }).expect(200);
      await rejoin({ accessCode: '7KPM4XQ2' }, hunt, 'outsider').expect(404);
      await rejoin({}, hunt, 'outsider').expect(404);
      await rejoin().expect(200); // A code replacement is not membership revocation.
    } finally { await db.query("UPDATE hunts SET access_code='7KPM4XQ2' WHERE id=$1", [hunt]); }
    expect((await db.query('SELECT * FROM hunt_participants ORDER BY id')).rows).toEqual(before);
  });

  it('rejoins historical Solo and Team identities at full capacity without changing roster or join time', async () => {
    for (const format of ['solo', 'team']) {
      const h = await makeHunt(signalClujNapocaV1);
      try {
        await db.query('UPDATE hunts SET hunt_format=$2,team_size=$3,capacity=1 WHERE id=$1', [h, format, format === 'solo' ? null : 4]);
        const member = (await db.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES($1,$2) RETURNING *', [h, actors.participant])).rows[0];
        if (format === 'team') {
          const team = (await db.query("INSERT INTO teams(hunt_id,name) VALUES($1,'Existing Team') RETURNING id", [h])).rows[0].id;
          await db.query('INSERT INTO team_members(hunt_id,team_id,hunt_participant_id) VALUES($1,$2,$3)', [h, team, member.id]);
        }
        const roster = (await db.query('SELECT * FROM team_members WHERE hunt_id=$1', [h])).rows;
        const responses = await Promise.all(Array.from({ length: 8 }, () => rejoin({}, h)));
        for (const response of responses) {
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({ participantId: member.id, joinedAt: member.joined_at.toISOString() });
        }
        expect((await db.query('SELECT * FROM team_members WHERE hunt_id=$1', [h])).rows).toEqual(roster);
        await rejoin({}, h, 'outsider').expect(404);
        expect((await db.query('SELECT count(*) FROM hunt_participants WHERE hunt_id=$1', [h])).rows[0].count).toBe('1');
      } finally { await db.query('DELETE FROM hunts WHERE id=$1', [h]); }
    }
  });

  it('rolls back partial context initialization after a database failure and retries the same identity', async () => {
    const h = await makeHunt(signalClujNapocaV1);
    const member = (await db.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES($1,$2) RETURNING *', [h, actors.participant])).rows[0];
    await db.query(`CREATE FUNCTION admission_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected context initialization failure'; END $$;
      CREATE TRIGGER admission_test_failure BEFORE INSERT ON participant_checkpoint_access
      FOR EACH ROW WHEN (NEW.participant_id='${member.id}'::uuid) EXECUTE FUNCTION admission_test_failure()`);
    try {
      await rejoin({}, h).expect(500);
      expect((await db.query('SELECT access_snapshot_digest FROM hunt_participants WHERE id=$1', [member.id])).rows[0].access_snapshot_digest).toBeNull();
      expect((await db.query('SELECT count(*) FROM hunt_checkpoint_identities WHERE hunt_id=$1', [h])).rows[0].count).toBe('0');
      expect((await db.query('SELECT count(*) FROM participant_checkpoint_access WHERE hunt_id=$1', [h])).rows[0].count).toBe('0');
    } finally {
      await db.query('DROP TRIGGER admission_test_failure ON participant_checkpoint_access; DROP FUNCTION admission_test_failure()');
    }
    expect((await rejoin({}, h).expect(200)).body.participantId).toBe(member.id);
    await db.query('DELETE FROM hunts WHERE id=$1', [h]);
  });

  it('keeps guest identity through a new server process; new or expired guest sessions cannot impersonate it', async () => {
    const before = (await get(hunt, 'guest').expect(200)).body;
    const script = `
      const { createApp } = await import('./dist/app.js');
      const { pool } = await import('./dist/lib/postgres.js');
      const app = createApp(); const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/hunts/' + process.env.TASK_HUNT + '/participants/me',
          { headers: { Authorization: process.env.TASK_AUTH } });
        console.log(JSON.stringify({ status: response.status, body: await response.json() }));
      } finally { await new Promise(resolve => server.close(resolve)); app.locals.stopAbuseProtection(); await pool.end(); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, DATABASE_URL: databaseUrl, TASK_HUNT: hunt, TASK_AUTH: auth('guest') },
    });
    expect(JSON.parse(stdout)).toEqual({ status: 200, body: before });
    const fresh = (await request(app).post('/api/auth/guest').send({ userId: actors.guest, participantId: before.participantId }).expect(201)).body;
    expect(fresh.user.id).not.toBe(actors.guest);
    expect(fresh.tokens.refreshToken).toBeUndefined();
    await request(app).get(`/api/hunts/${hunt}/participants/me`).set('Authorization', `Bearer ${fresh.tokens.accessToken}`).expect(404);
    await request(app).get(`/api/hunts/${hunt}/participants/me`).set('Authorization', `Bearer ${sign({ sub: actors.guest, type: 'access' }, { expiresIn: -1 })}`).expect(401);
    for (const who of ['blocked', 'retired']) await rejoin({}, hunt, who).expect(401);
  });
  it('rate limits repeated admission attempts without writing membership', async () => {
    let limited = false;
    for (let i = 0; i < 70; i++) {
      const r = await rejoin({accessCode:'9KPM4XQ2'}, hunt, 'admin');
      if (r.status === 429) { expect(Number(r.headers['retry-after'])).toBeGreaterThan(0); limited = true; break; }
      expect(r.status).toBe(404);
    }
    expect(limited).toBe(true);
    expect((await db.query('SELECT * FROM hunt_participants WHERE hunt_id=$1 AND user_id=$2',[hunt,actors.admin])).rowCount).toBe(0);
  });

});
