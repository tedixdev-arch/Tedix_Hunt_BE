import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(), list: vi.fn(), find: vi.fn(), approve: vi.fn(), requestChanges: vi.fn(),
}));
vi.mock('../models/User.js', () => ({ User: { findById: mocks.findUserById } }));
vi.mock('../models/HuntTemplate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../models/HuntTemplate.js')>();
  return { ...actual, HuntTemplates: {
    ...actual.HuntTemplates,
    listSubmittedCreatorReviews: mocks.list,
    findSubmittedCreatorReviewByKey: mocks.find,
    approveSubmittedCreator: mocks.approve,
    requestChangesForSubmittedCreator: mocks.requestChanges,
  } };
});

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';
import { HuntTemplateNotReviewableError } from '../models/HuntTemplate.js';

const identity = (roles: string[]) => ({
  id: 'admin-1', email: 'admin@example.com', role: 'participant', roles,
  name: 'Admin', isGuest: false, accountStatus: 'active', createdAt: new Date(),
});
const bearer = `Bearer ${signJwt({ sub: 'admin-1', type: 'access' })}`;
const review = (key = 'algebra-trail', version = 2) => ({
  key, version, status: 'submitted', origin: 'creator',
  creator: { id: 'creator-1', name: 'Ada', email: 'ada@example.com' },
  content: { key, version, displayName: `Immutable v${version}` },
});

describe('Admin Template review reads', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(identity(['admin']));
    mocks.list.mockResolvedValue([review('algebra-trail'), review('biology-path', 3)]);
    mocks.find.mockResolvedValue(review());
    mocks.approve.mockResolvedValue({ ...review(), status: 'approved' });
    mocks.requestChanges.mockResolvedValue({ ...review(), status: 'changes_requested' });
  });

  it('lists submitted Creator review artifacts deterministically as supplied by persistence', async () => {
    await request(app).get('/api/admin/templates/review').set('Authorization', bearer)
      .expect(200, { templates: [review('algebra-trail'), review('biology-path', 3)] });
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('inspects exact submitted content and Creator provenance without mutation', async () => {
    await request(app).get('/api/admin/templates/review/algebra-trail')
      .set('Authorization', bearer).expect(200, review());
    expect(mocks.find).toHaveBeenCalledWith('algebra-trail');
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'draft', 'approved', 'changes-requested', 'platform-signal'])
    ('returns not_found when %s is outside the review queue', async (key) => {
      mocks.find.mockResolvedValue(null);
      await request(app).get(`/api/admin/templates/review/${key}`)
        .set('Authorization', bearer).expect(404, { error: 'not_found' });
    });

  it.each([
    ['organizer', ['organizer']], ['creator', ['creator']], ['participant', ['participant']],
  ])('forbids an %s-only identity', async (_label, roles) => {
    mocks.findUserById.mockResolvedValue(identity(roles));
    await request(app).get('/api/admin/templates/review').set('Authorization', bearer)
      .expect(403, { error: 'forbidden' });
    await request(app).get('/api/admin/templates/review/algebra-trail')
      .set('Authorization', bearer).expect(403, { error: 'forbidden' });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it('allows a multi-role identity containing Admin', async () => {
    mocks.findUserById.mockResolvedValue(identity(['participant', 'creator', 'admin']));
    await request(app).get('/api/admin/templates/review').set('Authorization', bearer).expect(200);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/admin/templates/review').expect(401, { error: 'unauthorized' });
  });

  it('allows an Admin to approve the exact submitted artifact', async () => {
    await request(app).post('/api/admin/templates/review/algebra-trail/approve')
      .set('Authorization', bearer).expect(200, { ...review(), status: 'approved' });
    expect(mocks.approve).toHaveBeenCalledWith('algebra-trail');
  });

  it('does not expose missing Creator Templates through approval', async () => {
    mocks.approve.mockResolvedValue(null);
    await request(app).post('/api/admin/templates/review/signal-cluj-napoca/approve')
      .set('Authorization', bearer).expect(404, { error: 'not_found' });
  });

  it('returns a stable conflict when the Creator Template is no longer submitted', async () => {
    mocks.approve.mockRejectedValue(new HuntTemplateNotReviewableError());
    await request(app).post('/api/admin/templates/review/algebra-trail/approve')
      .set('Authorization', bearer)
      .expect(409, { error: 'template_not_reviewable' });
  });

  it.each([
    ['organizer', ['organizer']], ['creator', ['creator']], ['participant', ['participant']],
  ])('forbids an %s-only identity from approval', async (_label, roles) => {
    mocks.findUserById.mockResolvedValue(identity(roles));
    await request(app).post('/api/admin/templates/review/algebra-trail/approve')
      .set('Authorization', bearer).expect(403, { error: 'forbidden' });
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it('allows approval for a multi-role identity containing Admin', async () => {
    mocks.findUserById.mockResolvedValue(identity(['organizer', 'creator', 'admin']));
    await request(app).post('/api/admin/templates/review/algebra-trail/approve')
      .set('Authorization', bearer).expect(200);
  });

  it('allows an Admin to request changes to the exact submitted artifact', async () => {
    await request(app).post('/api/admin/templates/review/algebra-trail/request-changes')
      .set('Authorization', bearer).expect(200, { ...review(), status: 'changes_requested' });
    expect(mocks.requestChanges).toHaveBeenCalledWith('algebra-trail');
  });

  it('does not expose missing or platform Templates through request-changes', async () => {
    mocks.requestChanges.mockResolvedValue(null);
    await request(app).post('/api/admin/templates/review/signal-cluj-napoca/request-changes')
      .set('Authorization', bearer).expect(404, { error: 'not_found' });
  });

  it('rejects a repeated or otherwise ineligible request-changes transition', async () => {
    mocks.requestChanges.mockRejectedValue(new HuntTemplateNotReviewableError());
    await request(app).post('/api/admin/templates/review/algebra-trail/request-changes')
      .set('Authorization', bearer).expect(409, { error: 'template_not_reviewable' });
  });

  it.each([
    ['organizer', ['organizer']], ['creator', ['creator']], ['participant', ['participant']],
  ])('forbids an %s-only identity from requesting changes', async (_label, roles) => {
    mocks.findUserById.mockResolvedValue(identity(roles));
    await request(app).post('/api/admin/templates/review/algebra-trail/request-changes')
      .set('Authorization', bearer).expect(403, { error: 'forbidden' });
    expect(mocks.requestChanges).not.toHaveBeenCalled();
  });

  it('allows a multi-role identity containing Admin to request changes', async () => {
    mocks.findUserById.mockResolvedValue(identity(['organizer', 'creator', 'admin']));
    await request(app).post('/api/admin/templates/review/algebra-trail/request-changes')
      .set('Authorization', bearer).expect(200);
  });
});
