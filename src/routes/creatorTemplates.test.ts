import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(),
  deleteCreatorDraft: vi.fn(),
  createCreatorDraft: vi.fn(),
  createCreatorVersion: vi.fn(),
  submitCreatorDraft: vi.fn(),
  listCreatorOwnedWithLatestVersion: vi.fn(),
  findCreatorOwnedByKeyWithLatestVersion: vi.fn(),
}));
vi.mock('../models/User.js', () => ({ User: { findById: mocks.findUserById } }));
vi.mock('../models/HuntTemplate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../models/HuntTemplate.js')>();
  return {
    ...actual,
    HuntTemplates: {
      ...actual.HuntTemplates,
      deleteCreatorDraft: mocks.deleteCreatorDraft,
      createCreatorDraft: mocks.createCreatorDraft,
      createCreatorVersion: mocks.createCreatorVersion,
      submitCreatorDraft: mocks.submitCreatorDraft,
      listCreatorOwnedWithLatestVersion: mocks.listCreatorOwnedWithLatestVersion,
      findCreatorOwnedByKeyWithLatestVersion: mocks.findCreatorOwnedByKeyWithLatestVersion,
    },
  };
});

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';
import { pool } from '../lib/postgres.js';
import {
  HuntTemplateInUseError, HuntTemplateNotDeletableError, HuntTemplateKeyConflictError, HuntTemplateNotEditableError, HuntTemplateNotFoundError,
  HuntTemplateNotSubmittableError, HuntTemplateVersionNotLatestError,
  InvalidHuntTemplateContentError,
} from '../models/HuntTemplate.js';

const content = {
  key: 'algebra-trail', version: 1, displayName: 'Algebra Trail', theme: 'Numbers',
  mission: { name: 'Recover the code' },
  configuration: {
    durationMinutes: 45, normalCheckpointCount: 1,
    finishPoint: { name: 'City Wall', latitude: 46.78, longitude: 23.64, radiusMeters: 5 },
    checkpointPositions: [{
      checkpointNumber: 1, name: 'Central Square', latitude: 46.7712,
      longitude: 23.6236, radiusMeters: 30,
    }],
  },
  scoring: { startingScore: 100 }, checkpoints: [{ id: 'one', checkpoint: 1, arbitrary: ['kept'] }, { id: 'finish', role: 'terminal', kind: 'shared-final-key', teamKind: 'shared-final-key', navigationMode: 'none' }],
};
const user = (roles: string[]) => ({
  id: 'user-1', email: 'person@example.com', passwordHash: null, role: 'participant', roles,
  name: 'Person', isGuest: false, tedixUserId: null, accountStatus: 'active', createdAt: new Date(),
});
const bearer = `Bearer ${signJwt({ sub: 'user-1', type: 'access' })}`;

describe('GET /api/creator/templates/starters', () => {
  const app = createApp();
  const path = '/api/creator/templates/starters';
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user(['creator']));
  });

  it('lists both fixed starters for a Creator without reading private drafts or changing persistence', async () => {
    const query = vi.spyOn(pool, 'query');
    const connect = vi.spyOn(pool, 'connect');
    try {
      mocks.findUserById.mockResolvedValue(user(['participant', 'creator']));
      const first = await request(app).get(path).set('Authorization', bearer).expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.items.map((entry: any) => [entry.key, entry.displayName, entry.createdAt, entry.creationPath]))
        .toEqual([
          ['signal-cluj-napoca', 'Signal: Cluj Napoca', null, `${path}/signal-cluj-napoca`],
          ['signal-overload-cluj-napoca', 'Signal Overload - Cluj Napoca', null, `${path}/signal-overload-cluj-napoca`],
        ]);
      const second = await request(app).get(path).set('Authorization', bearer).expect(200);
      expect(second.body).toEqual(first.body);
      for (const [name, mock] of Object.entries(mocks)) {
        if (name !== 'findUserById') expect(mock).not.toHaveBeenCalled();
      }
      // Authentication is mocked above; catalog access must issue no SQL at all,
      // including writes to Templates, immutable versions, Hunts or snapshots.
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      connect.mockRestore();
    }
  });

  it('rejects absent or invalid authentication', async () => {
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', 'Bearer invalid').expect(401);
  });
  it.each([{ roles: ['participant'] }, { roles: ['organizer'] }, { roles: ['admin'] }, { roles: [] }])('rejects non-Creator roles $roles', async ({ roles }) => {
    mocks.findUserById.mockResolvedValue(user(roles));
    await request(app).get(path).set('Authorization', bearer).expect(403);
  });
  it('rejects guests with a saved Creator role', async () => {
    mocks.findUserById.mockResolvedValue({ ...user(['creator']), isGuest: true });
    await request(app).get(path).set('Authorization', bearer).expect(403);
  });
  it.each(['blocked', 'retired'])('rejects %s Creators', async (accountStatus) => {
    mocks.findUserById.mockResolvedValue({ ...user(['creator']), accountStatus });
    await request(app).get(path).set('Authorization', bearer).expect(401);
  });
});

describe('Creator-owned Template reads', () => {
  const app = createApp();
  const result = { key: content.key, version: 3, status: 'changes_requested', origin: 'creator', submittedVersion: null, content };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user(['creator']));
    mocks.listCreatorOwnedWithLatestVersion.mockResolvedValue([result]);
    mocks.findCreatorOwnedByKeyWithLatestVersion.mockResolvedValue(result);
  });

  it('lists complete latest persisted content for the authenticated Creator', async () => {
    await request(app).get('/api/creator/templates').set('Authorization', bearer)
      .expect(200, [result]);
    expect(mocks.listCreatorOwnedWithLatestVersion).toHaveBeenCalledWith('user-1');
  });

  it('reads complete latest persisted content by owner-scoped key', async () => {
    await request(app).get(`/api/creator/templates/${content.key}`).set('Authorization', bearer)
      .expect(200, result);
    expect(mocks.findCreatorOwnedByKeyWithLatestVersion)
      .toHaveBeenCalledWith(content.key, 'user-1');
  });

  it.each(['unknown', 'another-creators-key'])('uses the same not-found response for %s', async (key) => {
    mocks.findCreatorOwnedByKeyWithLatestVersion.mockResolvedValue(null);
    await request(app).get(`/api/creator/templates/${key}`).set('Authorization', bearer)
      .expect(404, { error: 'not_found' });
  });

  it.each([
    ['participant', ['participant']], ['organizer-only', ['organizer']], ['admin-only', ['admin']],
  ])('forbids a %s identity', async (_name, roles) => {
    mocks.findUserById.mockResolvedValue(user(roles));
    await request(app).get('/api/creator/templates').set('Authorization', bearer)
      .expect(403, { error: 'forbidden' });
    await request(app).get(`/api/creator/templates/${content.key}`).set('Authorization', bearer)
      .expect(403, { error: 'forbidden' });
  });

  it('allows a multi-role identity containing Creator capability', async () => {
    mocks.findUserById.mockResolvedValue(user(['admin', 'organizer', 'creator']));
    await request(app).get('/api/creator/templates').set('Authorization', bearer).expect(200);
  });
});

describe('POST /api/creator/templates/:key/submit', () => {
  const app = createApp();
  const version3 = { ...content, version: 3, displayName: 'Exact submitted content' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user(['creator']));
    mocks.submitCreatorDraft.mockResolvedValue({
      template: { key: content.key, origin: 'creator', status: 'submitted', submittedVersion: 3 },
      version: { version: 3, content: version3 },
    });
  });

  it('submits and returns the explicitly requested immutable version', async () => {
    await request(app).post(`/api/creator/templates/${content.key}/submit`)
      .set('Authorization', bearer).send({ version: 3 }).expect(200, {
        key: content.key, version: 3, status: 'submitted', origin: 'creator', content: version3,
      });
    expect(mocks.submitCreatorDraft).toHaveBeenCalledWith(content.key, 3, 'user-1');
  });

  it.each([
    ['unknown', new HuntTemplateNotFoundError(), 404, 'not_found'],
    ['other-owned', new HuntTemplateNotFoundError(), 404, 'not_found'],
    ['platform', new HuntTemplateNotFoundError(), 404, 'not_found'],
    ['older version', new HuntTemplateVersionNotLatestError(), 409, 'template_version_not_latest'],
    ['future version', new HuntTemplateVersionNotLatestError(), 409, 'template_version_not_latest'],
    ['submitted', new HuntTemplateNotSubmittableError(), 409, 'template_not_submittable'],
    ['approved', new HuntTemplateNotSubmittableError(), 409, 'template_not_submittable'],
    ['changes requested', new HuntTemplateNotSubmittableError(), 409, 'template_not_submittable'],
  ])('returns a stable response for %s', async (_case, error, status, code) => {
    mocks.submitCreatorDraft.mockRejectedValue(error);
    await request(app).post(`/api/creator/templates/${content.key}/submit`)
      .set('Authorization', bearer).send({ version: 3 }).expect(status, { error: code });
  });

  it.each([undefined, null, 0, 1.5, '3'])('rejects invalid version %s', async (version) => {
    await request(app).post(`/api/creator/templates/${content.key}/submit`)
      .set('Authorization', bearer).send({ version }).expect(400, { error: 'invalid_input' });
    expect(mocks.submitCreatorDraft).not.toHaveBeenCalled();
  });

  it('returns deterministic invalid_input when geographic content is incomplete', async () => {
    mocks.submitCreatorDraft.mockRejectedValue(new InvalidHuntTemplateContentError());
    await request(app).post(`/api/creator/templates/${content.key}/submit`)
      .set('Authorization', bearer).send({ version: 3 })
      .expect(400, { error: 'invalid_input' });
  });

  it.each([
    ['organizer-only', ['organizer']], ['admin-only', ['admin']],
  ])('forbids a %s identity', async (_name, roles) => {
    mocks.findUserById.mockResolvedValue(user(roles));
    await request(app).post(`/api/creator/templates/${content.key}/submit`)
      .set('Authorization', bearer).send({ version: 3 }).expect(403, { error: 'forbidden' });
    expect(mocks.submitCreatorDraft).not.toHaveBeenCalled();
  });

  it('allows a multi-role identity containing Creator capability', async () => {
    mocks.findUserById.mockResolvedValue(user(['admin', 'organizer', 'creator']));
    await request(app).post(`/api/creator/templates/${content.key}/submit`)
      .set('Authorization', bearer).send({ version: 3 }).expect(200);
  });
});

describe('POST /api/creator/templates', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user(['creator']));
    mocks.createCreatorDraft.mockResolvedValue({
      template: { key: content.key, origin: 'creator', status: 'draft' },
      version: { version: 1, content },
    });
  });

  it('lets a Creator create a normalized draft and returns complete version 1 content', async () => {
    const response = await request(app).post('/api/creator/templates').set('Authorization', bearer)
      .send({ key: '  Algebra-Trail ', content }).expect(201);
    expect(response.body).toEqual({ key: content.key, version: 1, status: 'draft', origin: 'creator', content });
    expect(mocks.createCreatorDraft).toHaveBeenCalledWith(content.key, content, 'user-1', undefined, undefined);
  });

  it('accepts and preserves progressive geographic draft content', async () => {
    const geographicDraft = {
      ...content,
      configuration: {
        normalCheckpointCount: 2,
        checkpointPositions: [{
          checkpointNumber: 1, name: 'Central Square', latitude: 46.7712,
          longitude: 23.6236, radiusMeters: 30,
        }],
      },
    };
    mocks.createCreatorDraft.mockResolvedValueOnce({
      template: { key: content.key, origin: 'creator', status: 'draft' },
      version: { version: 1, content: geographicDraft },
    });
    await request(app).post('/api/creator/templates').set('Authorization', bearer)
      .send({ key: content.key, content: geographicDraft }).expect(201, {
        key: content.key, version: 1, status: 'draft', origin: 'creator',
        content: geographicDraft,
      });
    expect(mocks.createCreatorDraft).toHaveBeenCalledWith(
      content.key, geographicDraft, 'user-1', undefined, undefined,
    );
  });

  it.each([
    ['participant', ['participant']], ['organizer-only', ['organizer']], ['admin-only', ['admin']],
  ])('forbids a %s identity', async (_name, roles) => {
    mocks.findUserById.mockResolvedValue(user(roles));
    await request(app).post('/api/creator/templates').set('Authorization', bearer)
      .send({ key: content.key, content }).expect(403, { error: 'forbidden' });
  });

  it('allows a multi-role identity containing Creator capability', async () => {
    mocks.findUserById.mockResolvedValue(user(['admin', 'organizer', 'creator']));
    await request(app).post('/api/creator/templates').set('Authorization', bearer)
      .send({ key: content.key, content }).expect(201);
  });

  it.each([
    ['multiple FinishPoints', { ...content, configuration: { ...content.configuration, finishPoint: [content.configuration.finishPoint, content.configuration.finishPoint] } }],
    ['numbered FinishPoint', { ...content, configuration: { ...content.configuration, finishPoint: { ...content.configuration.finishPoint, checkpointNumber: 2 } } }],
    ['incomplete FinishPoint', { ...content, configuration: { ...content.configuration, finishPoint: { name: 'City Wall' } } }],
    ['empty content', {}],
    ['missing required structure', { ...content, scoring: {} }],
    ['empty checkpoints', { ...content, checkpoints: [] }],
    ['key mismatch', { ...content, key: 'different' }],
    ['wrong version', { ...content, version: 2 }],
  ])('rejects %s', async (_name, badContent) => {
    await request(app).post('/api/creator/templates').set('Authorization', bearer)
      .send({ key: content.key, content: badContent }).expect(400, { error: 'invalid_input' });
    expect(mocks.createCreatorDraft).not.toHaveBeenCalled();
  });

  it('returns a stable conflict without exposing PostgreSQL details', async () => {
    mocks.createCreatorDraft.mockRejectedValue(new HuntTemplateKeyConflictError());
    await request(app).post('/api/creator/templates').set('Authorization', bearer)
      .send({ key: content.key, content }).expect(409, { error: 'template_key_conflict' });
  });
});

describe('POST /api/creator/templates/:key/versions', () => {
  const app = createApp();
  const version2 = { ...content, version: 2, displayName: 'Algebra Trail revised' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user(['creator']));
    mocks.createCreatorVersion.mockResolvedValue({
      template: { key: content.key, origin: 'creator', status: 'draft' },
      version: { version: 2, content: version2 },
    });
  });

  it('saves and returns a complete new immutable version', async () => {
    await request(app).post(`/api/creator/templates/${content.key}/versions`)
      .set('Authorization', bearer).send({ content: version2 }).expect(201, {
        key: content.key, version: 2, status: 'draft', origin: 'creator', content: version2,
      });
    expect(mocks.createCreatorVersion).toHaveBeenCalledWith(content.key, version2, 'user-1', undefined);
  });

  it.each([
    ['unknown', new HuntTemplateNotFoundError(), 404, 'not_found'],
    ['other-owned', new HuntTemplateNotFoundError(), 404, 'not_found'],
    ['platform', new HuntTemplateNotFoundError(), 404, 'not_found'],
    ['submitted', new HuntTemplateNotEditableError(), 409, 'template_not_editable'],
    ['changes requested', new HuntTemplateNotEditableError(), 409, 'template_not_editable'],
    ['approved', new HuntTemplateNotEditableError(), 409, 'template_not_editable'],
    ['invalid content', new InvalidHuntTemplateContentError(), 400, 'invalid_input'],
  ])('returns a stable response for %s', async (_case, error, status, code) => {
    mocks.createCreatorVersion.mockRejectedValue(error);
    await request(app).post(`/api/creator/templates/${content.key}/versions`)
      .set('Authorization', bearer).send({ content: version2 }).expect(status, { error: code });
  });

  it.each([
    ['organizer-only', ['organizer']], ['admin-only', ['admin']],
  ])('forbids a %s identity', async (_name, roles) => {
    mocks.findUserById.mockResolvedValue(user(roles));
    await request(app).post(`/api/creator/templates/${content.key}/versions`)
      .set('Authorization', bearer).send({ content: version2 })
      .expect(403, { error: 'forbidden' });
    expect(mocks.createCreatorVersion).not.toHaveBeenCalled();
  });

  it('allows a multi-role identity containing Creator capability', async () => {
    mocks.findUserById.mockResolvedValue(user(['admin', 'organizer', 'creator']));
    await request(app).post(`/api/creator/templates/${content.key}/versions`)
      .set('Authorization', bearer).send({ content: version2 }).expect(201);
  });
});

describe.each(['signal-cluj-napoca', 'signal-overload-cluj-napoca'])('POST /api/creator/templates/starters/%s', (starterKey) => {
  const app = createApp();
  const path = `/api/creator/templates/starters/${starterKey}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user(['creator']));
    mocks.createCreatorDraft.mockImplementation(async (key, content) => ({
      template: { key, origin: 'creator', status: 'draft', submittedVersion: null },
      version: { version: 1, content },
    }));
  });

  it('requires authentication before creating a starter', async () => {
    await request(app).post(path).expect(401, { error: 'unauthorized' });
    await request(app).post(path).set('Authorization', 'Bearer invalid').expect(401);
    expect(mocks.createCreatorDraft).not.toHaveBeenCalled();
  });

  it.each([{ roles: ['participant'] }, { roles: ['organizer'] }, { roles: ['admin'] }, { roles: [] }])
    ('rejects non-Creator capabilities $roles', async ({ roles }) => {
      mocks.findUserById.mockResolvedValue(user(roles));
      await request(app).post(path).set('Authorization', bearer).expect(403, { error: 'forbidden' });
      expect(mocks.createCreatorDraft).not.toHaveBeenCalled();
    });

  it('rejects a guest even if its saved role set contains Creator', async () => {
    mocks.findUserById.mockResolvedValue({ ...user(['creator']), isGuest: true });
    await request(app).post(path).set('Authorization', bearer).expect(403);
    expect(mocks.createCreatorDraft).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'retired'])('rejects an %s Creator', async (accountStatus) => {
    mocks.findUserById.mockResolvedValue({ ...user(['creator']), accountStatus });
    await request(app).post(path).set('Authorization', bearer).expect(401);
    expect(mocks.createCreatorDraft).not.toHaveBeenCalled();
  });

  it('creates server-owned content and uses the authenticated multi-role Creator as owner', async () => {
    mocks.findUserById.mockResolvedValue(user(['participant', 'admin', 'creator']));
    const response = await request(app).post(path).set('Authorization', bearer)
      .send({ key: '  My-Signal  ' }).expect(201);
    expect(response.body).toMatchObject({ key: 'my-signal', version: 1, origin: 'creator', status: 'draft' });
    expect(response.body.content.configuration.normalCheckpointCount).toBe(6);
    expect(response.body.content.routeResearch.proposal.candidates).toHaveLength(7);
    expect(response.body.content.routeResearch.proposal.physicalVerification).toBe('pending');
    expect(response.body.content.configuration.checkpointPositions).toEqual([]);
    expect(response.body.content.configuration).not.toHaveProperty('finishPoint');
    expect(response.body.content.checkpoints.filter((entry: any) => entry.role === 'terminal')).toHaveLength(1);
    expect(mocks.createCreatorDraft).toHaveBeenCalledWith('my-signal', response.body.content, 'user-1');
    expect(mocks.createCreatorVersion).not.toHaveBeenCalled();
    expect(mocks.submitCreatorDraft).not.toHaveBeenCalled();
  });

  it('generates distinct valid keys when key is omitted', async () => {
    const first = await request(app).post(path).set('Authorization', bearer).expect(201);
    const second = await request(app).post(path).set('Authorization', bearer).send({}).expect(201);
    expect(first.body.key).toMatch(new RegExp(`^${starterKey}-[a-f0-9-]{36}$`));
    expect(first.body.content.starterSource.key).toBe(starterKey);
    expect(second.body.key).not.toBe(first.body.key);
    expect(first.body.content.key).toBe(first.body.key);
    expect(second.body.content.key).toBe(second.body.key);
  });

  it.each([
    { key: '' }, { key: null }, { key: 42 }, { key: 'bad/key' }, { key: 'x'.repeat(101) },
    { content: {} }, { createdByUserId: 'another-creator' }, { status: 'approved' }, [],
  ])('rejects invalid input or client overrides %j', async (body) => {
    await request(app).post(path).set('Authorization', bearer).send(body)
      .expect(400, { error: 'invalid_input' });
    expect(mocks.createCreatorDraft).not.toHaveBeenCalled();
  });

  it.each(['own-draft', 'other-creators-key', 'signal-cluj-napoca'])
    ('returns the existing conflict response without overwriting %s', async (key) => {
      mocks.createCreatorDraft.mockRejectedValueOnce(new HuntTemplateKeyConflictError());
      await request(app).post(path).set('Authorization', bearer).send({ key })
        .expect(409, { error: 'template_key_conflict' });
      expect(mocks.createCreatorDraft).toHaveBeenCalledTimes(1);
      expect(mocks.createCreatorVersion).not.toHaveBeenCalled();
    });
});


describe('Creator draft deletion API', () => {
  const app = createApp();
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteCreatorDraft.mockReset();
    mocks.findUserById.mockResolvedValue(user(['creator']));
  });
  it('deletes as the authenticated owner and returns an empty 204', async () => {
    const response = await request(app).delete('/api/creator/templates/algebra-trail')
      .set('Authorization', bearer).expect(204);
    expect(response.text).toBe('');
    expect(mocks.deleteCreatorDraft).toHaveBeenCalledWith('algebra-trail', 'user-1');
  });
  it.each(['missing', 'other-owner', 'platform'])('hides %s Templates', async (key) => {
    mocks.deleteCreatorDraft.mockRejectedValue(new HuntTemplateNotFoundError());
    await request(app).delete(`/api/creator/templates/${key}`).set('Authorization', bearer)
      .expect(404, { error: 'not_found' });
  });
  it.each([
    [new HuntTemplateNotDeletableError(), 'template_not_deletable'],
    [new HuntTemplateInUseError(), 'template_in_use'],
  ])('returns a stable conflict', async (error, code) => {
    mocks.deleteCreatorDraft.mockRejectedValue(error);
    await request(app).delete('/api/creator/templates/algebra-trail').set('Authorization', bearer)
      .expect(409, { error: code });
  });
  it('returns 404 for a repeated deletion', async () => {
    mocks.deleteCreatorDraft.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new HuntTemplateNotFoundError());
    await request(app).delete('/api/creator/templates/algebra-trail').set('Authorization', bearer).expect(204);
    await request(app).delete('/api/creator/templates/algebra-trail').set('Authorization', bearer)
      .expect(404, { error: 'not_found' });
  });
  it('requires authentication', async () => {
    await request(app).delete('/api/creator/templates/algebra-trail').expect(401);
    expect(mocks.deleteCreatorDraft).not.toHaveBeenCalled();
  });
  it.each([['participant'], ['organizer'], ['admin']])('requires Creator capability: %s', async (role) => {
    mocks.findUserById.mockResolvedValue(user([role]));
    await request(app).delete('/api/creator/templates/algebra-trail').set('Authorization', bearer).expect(403);
    expect(mocks.deleteCreatorDraft).not.toHaveBeenCalled();
  });
});
