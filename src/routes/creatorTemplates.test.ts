import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(),
  createCreatorDraft: vi.fn(),
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
      createCreatorDraft: mocks.createCreatorDraft,
      listCreatorOwnedWithLatestVersion: mocks.listCreatorOwnedWithLatestVersion,
      findCreatorOwnedByKeyWithLatestVersion: mocks.findCreatorOwnedByKeyWithLatestVersion,
    },
  };
});

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';
import { HuntTemplateKeyConflictError } from '../models/HuntTemplate.js';

const content = {
  key: 'algebra-trail', version: 1, displayName: 'Algebra Trail', theme: 'Numbers',
  mission: { name: 'Recover the code' }, configuration: { durationMinutes: 45 },
  scoring: { startingScore: 100 }, checkpoints: [{ id: 'one', arbitrary: ['kept'] }],
};
const user = (roles: string[]) => ({
  id: 'user-1', email: 'person@example.com', passwordHash: null, role: 'participant', roles,
  name: 'Person', isGuest: false, tedixUserId: null, accountStatus: 'active', createdAt: new Date(),
});
const bearer = `Bearer ${signJwt({ sub: 'user-1', type: 'access' })}`;

describe('Creator-owned Template reads', () => {
  const app = createApp();
  const result = { key: content.key, version: 3, status: 'changes_requested', origin: 'creator', content };

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
    expect(mocks.createCreatorDraft).toHaveBeenCalledWith(content.key, content, 'user-1');
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
