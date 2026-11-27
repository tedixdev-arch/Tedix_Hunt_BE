import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';
import { exerciseFixtures } from '../test/customExercises.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const databaseName = `custom_play_${randomUUID().replaceAll('-', '')}`;
const fixture = (type: string) => structuredClone(exerciseFixtures.find(e => e.type === type)!);

/** Creator-shaped snapshot: numbered checkpoints 1…N followed by the terminal FinishPoint. */
const snapshot = {
  key: 'custom-play', version: 1, displayName: 'Custom play', theme: 'Numbers', mission: { name: 'Crack the code', briefing: 'Go!' },
  scoring: { model: 'platform' },
  configuration: { normalCheckpointCount: 2,
    checkpointPositions: [1, 2].map(n => ({ checkpointNumber: n, name: `Point ${n}`, latitude: 46, longitude: 23, radiusMeters: 30 })),
    finishPoint: { name: 'Finish', latitude: 46, longitude: 23, radiusMeters: 30 } },
  checkpoints: [
    { checkpoint: 1, role: 'normal', kind: 'hidden-rule', prompt: 'PREDEFINED PROMPT', storyObjective: 'Pick the answer',
      customExercises: { personal: fixture('single-choice'), team: fixture('scrambled-word') } },
    { checkpoint: 2, role: 'normal', kind: 'hidden-rule', storyObjective: 'Order the steps', customExercises: { personal: fixture('sequence') } },
    { role: 'terminal', storySuccess: 'Mission accomplished', customExercises: { team: fixture('distributed-information') } },
  ],
};

suite('Custom exercise gameplay against disposable PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool, appPool: Pool | undefined, created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let sign: typeof import('../lib/jwt.js').signJwt;
  const actors: Record<string, string> = {};
  let org: string, hunt: string;
  const auth = (who = 'player') => `Bearer ${sign({ sub: actors[who], type: 'access' })}`;
  const play = async () => { const r = await request(app).get(`/api/hunts/${hunt}/participants/me/play`).set('Authorization', auth()); if (r.status !== 200) throw new Error(`play ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  const arrive = (checkpointId: string) => request(app).post(`/api/hunts/${hunt}/checkpoints/${checkpointId}/proximity`).set('Authorization', auth())
    .send({ latitude: 46, longitude: 23, accuracyMeters: 1, observedAt: new Date().toISOString() });
  const answer = (checkpointId: string, body: object) => request(app).post(`/api/hunts/${hunt}/checkpoints/${checkpointId}/answer`).set('Authorization', auth()).send(body);

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const f of (await readdir(directory)).filter(n => /^\d{3}_.*\.ts$/.test(n)).sort()) migrations.push((await import(new URL(f, directory).href)).default);
      await runMigrations(client, migrations);
    } finally { client.release(); }
    for (const who of ['player', 'organizer']) {
      actors[who] = (await db.query(`INSERT INTO users(email,role) VALUES($1,'participant') RETURNING id`, [`${who}@custom-play.invalid`])).rows[0].id;
      await db.query('INSERT INTO user_roles VALUES($1,$2)', [actors[who], who === 'organizer' ? 'organizer' : 'participant']);
    }
    org = (await db.query("INSERT INTO organizations(name,owner_id) VALUES('Custom play org',$1) RETURNING id", [actors.organizer])).rows[0].id;
    // A complete draft, published through the real endpoint so the readiness gate is exercised.
    hunt = (await db.query(`INSERT INTO hunts (organization_id,created_by_user_id,name,status,country,city,start_date,start_time,timezone,
        duration_minutes,capacity,contact_name,template_key,template_version,template_snapshot,hunt_format,team_size,access_mode,difficulty,checkpoint_order)
      VALUES ($1,$2,'Custom play','draft','Romania','Cluj-Napoca','2027-05-01','10:00','Europe/Bucharest',90,30,'Olga','custom-play',1,$3,'team',4,'invitation_only','easy','recommended')
      RETURNING id`, [org, actors.organizer, snapshot])).rows[0].id;
    await db.query(`INSERT INTO hunt_roles VALUES ($1,$2,'organizer')`, [hunt, actors.organizer]);
    const { environment } = await import('../config/environment.js'); environment.databaseUrl = url.toString();
    appPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); sign = (await import('../lib/jwt.js')).signJwt;
  }, 30000);
  afterAll(async () => {
    app?.locals.stopAbuseProtection?.(); await appPool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await admin.end();
  });

  it('publishes a Hunt whose template uses custom exercises', async () => {
    await request(app).post(`/api/hunts/${hunt}/publish`).set('Authorization', auth('organizer')).expect(200);
    await request(app).post(`/api/hunts/${hunt}/start`).set('Authorization', auth('organizer')).expect(200);
    await db.query('INSERT INTO hunt_participants(hunt_id,user_id) VALUES($1,$2)', [hunt, actors.player]);
  });

  it('plays custom Personal and Team stages server-side, revealing nothing before they are solved', async () => {
    let state = await play();
    const [cp1, cp2, finish] = state.checkpoints.map((c: any) => c.checkpointId);
    expect(state.stage).toBe('navigate');
    const arrival = await arrive(cp1); expect(arrival.status, JSON.stringify(arrival.body)).toBe(200);
    state = await play();
    expect(state.stage).toBe('personal');
    expect(state.current.playable).toBe(true);
    expect(state.current.personalExercise).toMatchObject({ type: 'single-choice', interaction: { options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] } });
    expect(state.current.story).toMatchObject({ storyObjective: 'Pick the answer', answerKeys: [] });
    const json = JSON.stringify(state);
    for (const secret of ['"answer"', 'optionId', 'First hint', 'Explain', 'PREDEFINED PROMPT', 'Correct']) expect(json).not.toContain(secret);

    await answer(cp1, { stage: 'personal', answers: { x: 'a' } }).expect(400, { error: 'invalid_input' });
    await answer(cp1, { stage: 'personal', response: { optionId: '<a>' } }).expect(400);
    await answer(cp1, { stage: 'team', response: { word: 'BA' } }).expect(409, { error: 'personal_stage_required' });
    const wrong = (await answer(cp1, { stage: 'personal', response: { optionId: 'b' } }).expect(200)).body;
    expect(wrong).toMatchObject({ correct: false, checkpointCompleted: false }); expect(wrong.reveal).toBeUndefined();
    const right = (await answer(cp1, { stage: 'personal', response: { optionId: 'a' } }).expect(200)).body;
    expect(right).toMatchObject({ correct: true, checkpointCompleted: false, reveal: { successText: 'Correct' } });
    expect(right.state.stage).toBe('team');
    expect(right.state.current.teamExercise.type).toBe('scrambled-word');
    expect(right.state.current.personalReveal).toEqual({ successText: 'Correct' });
    expect(JSON.stringify(right.state.current.teamExercise)).not.toContain('"word"');
    await answer(cp1, { stage: 'personal', response: { optionId: 'a' } }).expect(409, { error: 'stage_already_solved' });
    const team = (await answer(cp1, { stage: 'team', response: { word: ' b a ' } }).expect(200)).body;
    expect(team).toMatchObject({ correct: true, checkpointCompleted: true });

    // Personal-only checkpoint completes without a Team stage.
    await arrive(cp2).expect(200);
    expect((await play()).current.personalExercise.type).toBe('sequence');
    await answer(cp2, { stage: 'team', response: { optionId: 'a' } }).expect(409, { error: 'stage_unavailable' });
    expect((await answer(cp2, { stage: 'personal', response: { order: ['a', 'b'] } }).expect(200)).body.correct).toBe(false);
    expect((await answer(cp2, { stage: 'personal', response: { order: ['b', 'a'] } }).expect(200)).body.checkpointCompleted).toBe(true);

    // Team-only FinishPoint starts directly at the Team stage.
    await arrive(finish).expect(200);
    state = await play();
    expect(state.stage).toBe('team');
    expect(state.current.teamExercise.type).toBe('distributed-information');
    expect(state.current.personalReveal).toBeUndefined();
    const done = (await answer(finish, { stage: 'team', response: { optionId: 'a' } }).expect(200)).body;
    expect(done).toMatchObject({ correct: true, checkpointCompleted: true, reveal: { storySuccess: 'Correct', teamAnswer: null } });
    expect(done.state.stage).toBe('finished');
    expect(done.state.history.map((h: any) => h.storySuccess)).toEqual(['Correct', 'Correct', 'Correct']);
  });

  it("awards Platform Settings points for Creator 'platform' scoring and records every attempt", async () => {
    const events = (await db.query(`SELECT category, points FROM participant_score_events e JOIN hunt_participants p ON p.id=e.participant_id
      WHERE p.user_id=$1 ORDER BY e.created_at`, [actors.player])).rows;
    expect(events.filter(e => e.category === 'personal_solved').length).toBe(2);
    expect(events.filter(e => e.category === 'team_solved').length).toBe(1);
    expect(events.every(e => e.points >= 0)).toBe(true);
    expect((await play()).score).toBeGreaterThan(0);
    const attempts = (await db.query(`SELECT stage, correct FROM participant_challenge_attempts a JOIN hunt_participants p ON p.id=a.participant_id
      WHERE p.user_id=$1`, [actors.player])).rows;
    // cp1: wrong + right personal, team; cp2: wrong + right; FinishPoint team. Rejected (400/409) bodies are not attempts.
    expect(attempts).toHaveLength(6);
  });
});
