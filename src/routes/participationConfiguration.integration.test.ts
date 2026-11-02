import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import type { Migration } from '../db/migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const databaseName = `participation_${randomUUID().replaceAll('-', '')}`;
type Actor = { id: string; auth: string };
(testUrl ? describe : describe.skip)('Participation configuration: authenticated Express and PostgreSQL', () => {
  const admin = new Pool({ connectionString: testUrl });
  let db: Pool, applicationPool: Pool | undefined, created = false;
  let app: ReturnType<typeof import('../app.js').createApp>;
  let signJwt: typeof import('../lib/jwt.js').signJwt;
  let owner: Actor, participant: Actor;
  let organizationId: string;
  const actor = async (roles: string[]): Promise<Actor> => {
    const id = (await db.query("INSERT INTO users(email,role) VALUES ($1,'participant') RETURNING id", [`${randomUUID()}@example.invalid`])).rows[0].id;
    for (const role of roles) await db.query('INSERT INTO user_roles(user_id,role) VALUES ($1,$2)', [id, role]);
    return { id, auth: `Bearer ${signJwt({ sub: id, type: 'access' })}` };
  };
  const patch = (id: string, body: object) => request(app).patch(`/api/hunts/${id}`).set('Authorization', owner.auth).send(body);
  const get = (id: string) => request(app).get(`/api/hunts/${id}`).set('Authorization', owner.auth);
  const hunt = async () => (await request(app).post('/api/hunts').set('Authorization', owner.auth)
    .send({ organizationId, name: 'Mode fixture' }).expect(201)).body.id as string;
  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${databaseName}"`); created = true;
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('../db/pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('../db/migrations/', import.meta.url), migrations: Migration[] = [];
      for (const name of (await readdir(directory)).filter(n => /^\d{3}_.*\.ts$/.test(n)).sort()) migrations.push((await import(new URL(name, directory).href)).default);
      await runMigrations(client, migrations.filter(m => !m.id.startsWith('035_')));
      const user = (await client.query("INSERT INTO users(email,role) VALUES ('legacy@example.invalid','participant') RETURNING id")).rows[0].id;
      const org = (await client.query("INSERT INTO organizations(name,owner_id) VALUES ('Legacy',$1) RETURNING id",[user])).rows[0].id;
      const legacy = (await client.query("INSERT INTO hunts(organization_id,created_by_user_id,name,status,hunt_format,team_size) VALUES ($1,$2,'Legacy','draft','team',4),($1,$2,'Unconfigured','draft',null,null) RETURNING *",[org,user])).rows;
      const applied = await runMigrations(client, migrations);
      expect(applied).toEqual(['035_hunt_participation_configuration']);
      expect((await client.query('SELECT * FROM hunts ORDER BY name')).rows).toEqual(legacy.sort((a,b) => a.name.localeCompare(b.name)));

      expect(await runMigrations(client, migrations)).toEqual([]);
    } finally { client.release(); }
    (await import('../config/environment.js')).environment.databaseUrl = url.toString();
    applicationPool = (await import('../lib/postgres.js')).pool;
    app = (await import('../app.js')).createApp(); signJwt = (await import('../lib/jwt.js')).signJwt;
    owner = await actor(['creator', 'organizer']);
    participant = await actor(['participant']);
    organizationId = (await db.query("INSERT INTO organizations(name,owner_id) VALUES ('Fixture',$1) RETURNING id", [owner.id])).rows[0].id;
  }, 30000);
  afterAll(async () => {
    app?.locals.stopAbuseProtection?.();
    await applicationPool?.end(); await db?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  });

  it.each([2, 3, 4, 5, 6])('saves and reopens Team size %s without divisibility or roster assumptions', async (teamSize) => {
    const id = await hunt();
    await patch(id, { format: 'team', teamSize }).expect(200);
    expect((await get(id).expect(200)).body).toMatchObject({ format: 'team', teamSize });
    expect((await db.query('SELECT count(*) FROM team_members WHERE hunt_id=$1', [id])).rows[0].count).toBe('0');
  });
  it('switches Team to Solo and clears inapplicable size; enrollment needs no Team', async () => {
    const id = await hunt();
    await patch(id, { format: 'team', teamSize: 4 }).expect(200);
    await patch(id, { format: 'solo' }).expect(200);
    expect((await get(id).expect(200)).body).toMatchObject({ format: 'solo', teamSize: null });
    const { HuntParticipant } = await import('../models/HuntParticipant.js');
    expect(await HuntParticipant.enroll(id, participant.id)).toMatchObject({ huntId: id, userId: participant.id });
    await patch(id, { teamSize: 3 }).expect(400);
    await patch(id, { format: 'team', teamSize: 3 }).expect(200);
  });
  it.each([{format:'single'}, {format:null}, {teamSize:'4'}, {teamSize:0}, {teamSize:-1},
    {teamSize:1.5}, {teamSize:true}, {teamSize:2147483648}, {format:'solo',teamSize:4}])('rejects malformed setup %j without writing', async body => {
    const id = await hunt();
    await patch(id, body).expect(400);
    expect((await get(id).expect(200)).body).toMatchObject({ format: null, teamSize: null });
  });
  it('preserves selected immutable source and blocks unsupported modes without dropping content', async () => {
    const id = await hunt();
    await patch(id, { templateKey: 'signal-cluj-napoca', format: 'team', teamSize: 4,
      country:'Romania', city:'Cluj', startDate:'2027-01-01', startTime:'10:00', timezone:'Europe/Bucharest',
      durationMinutes:60, capacity:24, contactName:'Contact', accessMode:'invitation_only', difficulty:'easy', checkpointOrder:'recommended' }).expect(200);
    const snapshot = (await get(id)).body.templateSnapshot;
    for (const config of [{format:'solo',teamSize:null}, {format:'team',teamSize:3}]) {
      await patch(id, config).expect(200);
      expect((await get(id)).body.templateSnapshot).toEqual(snapshot);
      const denied = await request(app).post(`/api/hunts/${id}/publish`).set('Authorization',owner.auth).expect(422);
      expect(denied.body.issues.some((i: {message:string}) => i.message.includes('D5'))).toBe(true);
    }
    await patch(id, {format:'team',teamSize:4}).expect(200);
    await request(app).post(`/api/hunts/${id}/publish`).set('Authorization',owner.auth).expect(200);
    await patch(id, {format:'solo'}).expect(409);
    expect((await get(id)).body.templateSnapshot).toEqual(snapshot);
  });
  it('enforces canonical mode and Solo size at the database boundary', async () => {
    const id = await hunt();
    await expect(db.query("UPDATE hunts SET hunt_format='other' WHERE id=$1",[id])).rejects.toThrow();
    await expect(db.query("UPDATE hunts SET hunt_format='solo',team_size=4 WHERE id=$1",[id])).rejects.toThrow();
  });
});
