import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), findUser: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({ pool: { query: mocks.query, connect: mocks.connect } }));
vi.mock('../models/User.js', () => ({ User: { findById: mocks.findUser } }));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';
import { signalClujNapocaV1 } from '../domain/templates/signalClujNapocaV1.js';
import { swaggerSpec } from '../lib/swagger.js';

const app = createApp();
const auth = `Bearer ${signJwt({ sub: 'organizer-1', type: 'access' })}`;
const path = '/api/hunt-templates/trail/geography';
const point = { name: '  Saved name  ', latitude: 46.771234, longitude: 23.623456, radiusMeters: 5 };
const configuration = {
  normalCheckpointCount: 2,
  checkpointPositions: [{ ...point, checkpointNumber: 2 }, { ...point, checkpointNumber: 1 }],
  finishPoint: { ...point, name: 'Saved finish' },
};
const approved = () => ({
  key: 'trail', version: 3,
  content: { key: 'trail', version: 3, displayName: 'Trail', theme: 'Explore', configuration },
});
const user = { id: 'organizer-1', roles: ['organizer'], isGuest: false, accountStatus: 'active' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findUser.mockResolvedValue(user);
  mocks.query.mockResolvedValue({ rows: [approved()] });
});

describe('approved Template geography', () => {
  it('allows an Organizer and preserves stored values, array order and numbering', async () => {
    const response = await request(app).get(path).set('Authorization', auth).expect(200);
    expect(response.body).toEqual({ key: 'trail', version: 3, configuration });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = mocks.query.mock.calls[0];
    expect(sql).toContain("t.status = 'approved' AND t.key = $1");
    expect(sql).toContain("t.origin = 'platform' OR version = t.submitted_version");
    expect(parameters).toEqual(['trail']);
  });

  it.each([undefined, 'Bearer invalid', `Bearer ${signJwt({ sub: user.id, type: 'refresh' })}`])(
    'rejects missing, invalid or non-access credentials %# before reading content', async (header) => {
      const call = request(app).get(path);
      if (header) call.set('Authorization', header);
      await call.expect(401, { error: 'unauthorized' });
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );

  it.each(['blocked', 'retired', 'missing'])('rejects a %s account', async (status) => {
    mocks.findUser.mockResolvedValue(status === 'missing' ? null : { ...user, accountStatus: status });
    await request(app).get(path).set('Authorization', auth).expect(401, { error: 'unauthorized' });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['admin', 'creator', 'participant'])('preserves catalog access for authenticated %s users', async (role) => {
    mocks.findUser.mockResolvedValue({ ...user, roles: [role] });
    await request(app).get(path).set('Authorization', auth).expect(200);
  });

  it('ignores client version overrides and uses the exact repository identity rather than content metadata', async () => {
    const row = approved();
    mocks.query.mockResolvedValue({ rows: [{ ...row, content: { ...row.content, key: 'other', version: 99 } }] });
    const response = await request(app).get(`${path}?version=99`).set('Authorization', auth).expect(200);
    expect(response.body).toEqual({ key: 'trail', version: 3, configuration });
    expect(mocks.query.mock.calls[0][1]).toEqual(['trail']);
  });

  it('aligns with the unchanged catalog metadata contract', async () => {
    const catalog = await request(app).get('/api/hunt-templates').set('Authorization', auth).expect(200);
    expect(catalog.body).toEqual([{ key: 'trail', version: 3, displayName: 'Trail', theme: 'Explore' }]);
    const geography = await request(app).get(path).set('Authorization', auth).expect(200);
    expect(geography.body.key).toBe(catalog.body[0].key);
    expect(geography.body.version).toBe(catalog.body[0].version);
  });

  it('resolves approval anew after a catalog request so clients can detect stale versions', async () => {
    const catalog = await request(app).get('/api/hunt-templates').set('Authorization', auth).expect(200);
    const next = { ...approved(), version: 4, content: { ...approved().content, configuration: { finishPoint: point } } };
    mocks.query.mockResolvedValueOnce({ rows: [next] });
    const geography = await request(app).get(path).set('Authorization', auth).expect(200);
    expect(geography.body).toEqual({ key: 'trail', version: 4, configuration: { finishPoint: point } });
    expect(geography.body.version).not.toBe(catalog.body[0].version);
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await request(app).get(path).set('Authorization', auth).expect(404, { error: 'not_found' });
  });

  it.each(['missing', 'draft', 'submitted', 'changes_requested'])('hides %s Templates without a fallback', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await request(app).get(path).set('Authorization', auth).expect(404, { error: 'not_found' });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    { configuration: undefined },
    { configuration: { durationMinutes: 30 } },
    { configuration: signalClujNapocaV1.configuration },
  ])('returns empty legacy geography without manufacturing Signal coordinates %#', async ({ configuration: saved }) => {
    mocks.query.mockResolvedValue({ rows: [{ ...approved(), content: { configuration: saved } }] });
    await request(app).get(path).set('Authorization', auth).expect(200, { key: 'trail', version: 3, configuration: {} });
  });

  it('preserves partial and empty geography without repairs or inserted defaults', async () => {
    const partial = { normalCheckpointCount: 7, checkpointPositions: [{ checkpointNumber: 5, name: 'Only name' }, {}] };
    mocks.query.mockResolvedValueOnce({ rows: [{ ...approved(), content: { configuration: partial } }] });
    await request(app).get(path).set('Authorization', auth).expect(200, { key: 'trail', version: 3, configuration: partial });
    const empty = { checkpointPositions: [], finishPoint: {} };
    mocks.query.mockResolvedValueOnce({ rows: [{ ...approved(), content: { configuration: empty } }] });
    await request(app).get(path).set('Authorization', auth).expect(200, { key: 'trail', version: 3, configuration: empty });
  });

  it('allowlists nested points and neither leaks private content nor mutates the source', async () => {
    const row = { ...approved(), content: {
      ...approved().content, mission: { answer: 'private' }, checkpoints: [{ answer: 'private', question: 'private' }],
      scoring: { secret: true }, rewards: { secret: true }, reviewNotes: 'private',
      configuration: { ...configuration, answers: ['private'],
        checkpointPositions: configuration.checkpointPositions.map((p) => ({ ...p, challenge: { answer: 'private' } })),
        finishPoint: { ...configuration.finishPoint, question: 'private', answers: ['private'] },
      },
    } };
    const before = structuredClone(row);
    mocks.query.mockResolvedValueOnce({ rows: [row] });
    await request(app).get(path).set('Authorization', auth).expect(200, { key: 'trail', version: 3, configuration });
    expect(row).toEqual(before);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][0].trim()).toMatch(/^SELECT/);
  });

  it.each([
    null, [], { normalCheckpointCount: '2' }, { checkpointPositions: null },
    { checkpointPositions: [null] }, { checkpointPositions: [{ latitude: { answer: 'private' } }] },
    { finishPoint: null }, { finishPoint: { name: { answer: 'private' } } },
  ])('reports malformed stored geography without repairing or leaking it %#', async (saved) => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...approved(), content: { configuration: saved } }] });
    await request(app).get(path).set('Authorization', auth)
      .expect(409, { error: 'template_geography_unavailable' });
  });

  it('documents the runtime security, errors and optional allowlisted geography', () => {
    expect(swaggerSpec).toHaveProperty('paths./api/hunt-templates/{key}/geography.get.security', [{ bearerAuth: [] }]);
    for (const status of ['200', '401', '404', '409']) {
      expect(swaggerSpec).toHaveProperty(`paths./api/hunt-templates/{key}/geography.get.responses.${status}`);
    }
    expect(swaggerSpec).toHaveProperty('components.schemas.HuntTemplateGeography.required', ['key', 'version', 'configuration']);
    expect(swaggerSpec).toHaveProperty('components.schemas.HuntTemplateGeographicPoint.additionalProperties', false);
    expect(swaggerSpec).toHaveProperty('components.schemas.HuntTemplateCheckpointPosition.additionalProperties', false);
  });
});
