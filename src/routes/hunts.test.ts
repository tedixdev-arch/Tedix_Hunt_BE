import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(),
  findHuntById: vi.fn(),
  findHuntsForUser: vi.fn(),
  createHunt: vi.fn(),
  updateDraft: vi.fn(),
  transitionStatus: vi.fn(),
  hasHuntRole: vi.fn(),
  findOrganizationById: vi.fn(),
  isOwner: vi.fn(),
  isMember: vi.fn(),
}));

vi.mock('../models/User.js', () => ({ User: { findById: mocks.findUserById } }));
vi.mock('../models/Hunt.js', () => ({
  Hunt: {
    findById: mocks.findHuntById,
    findForUser: mocks.findHuntsForUser,
    createWithOrganizerRole: mocks.createHunt,
    updateDraft: mocks.updateDraft,
    transitionStatus: mocks.transitionStatus,
  },
}));
vi.mock('../models/HuntRole.js', () => ({ HuntRoles: { hasRole: mocks.hasHuntRole } }));
vi.mock('../models/Organization.js', () => ({
  Organization: {
    findById: mocks.findOrganizationById,
    isOwner: mocks.isOwner,
    isMember: mocks.isMember,
  },
}));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const now = new Date('2026-09-17T12:00:00Z');
const user = {
  id: 'user-1', email: 'creator@example.com', passwordHash: null, role: 'participant' as const,
  roles: ['participant', 'creator'], name: 'Creator', isGuest: false, tedixUserId: null, createdAt: now,
};
const hunt = {
  id: 'hunt-1', organizationId: 'org-1', createdByUserId: user.id, name: 'City Hunt',
  status: 'draft' as const, createdAt: now, updatedAt: now,
};
const auth = `Bearer ${signJwt({ sub: user.id, type: 'access' })}`;
const app = createApp();

describe('Hunt routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user);
    mocks.findHuntById.mockResolvedValue(hunt);
    mocks.findHuntsForUser.mockResolvedValue([]);
    mocks.findOrganizationById.mockResolvedValue({ id: 'org-1' });
    mocks.isOwner.mockResolvedValue(false);
    mocks.isMember.mockResolvedValue(true);
    mocks.hasHuntRole.mockImplementation((_huntId, _userId, role) => role === 'organizer');
    mocks.createHunt.mockResolvedValue(hunt);
    mocks.updateDraft.mockResolvedValue({ ...hunt, name: 'Renamed' });
    mocks.transitionStatus.mockImplementation(({ to }) => Promise.resolve({ ...hunt, status: to }));
  });

  it('requires authentication to list Hunts', async () => {
    await request(app).get('/api/hunts').expect(401, { error: 'unauthorized' });
    expect(mocks.findHuntsForUser).not.toHaveBeenCalled();
  });

  it.each([
    ['organizer', ['organizer']],
    ['supervisor', ['supervisor']],
    ['both roles', ['organizer', 'supervisor']],
  ])('lists a Hunt once for a user with %s', async (_description, huntRoles) => {
    mocks.findHuntsForUser.mockResolvedValueOnce([{ ...hunt, huntRoles }]);
    const response = await request(app).get('/api/hunts').set('Authorization', auth).expect(200);

    expect(response.body).toEqual([{ ...hunt, createdAt: now.toISOString(), updatedAt: now.toISOString(), huntRoles }]);
    expect(mocks.findHuntsForUser).toHaveBeenCalledWith(user.id);
  });

  it.each(['creator', 'organizer'])('does not list Hunts from the global %s role alone', async (role) => {
    mocks.findUserById.mockResolvedValueOnce({ ...user, roles: ['participant', role] });
    await request(app).get('/api/hunts').set('Authorization', auth).expect(200, []);
    expect(mocks.findHuntsForUser).toHaveBeenCalledWith(user.id);
  });

  it('returns an empty list for an unrelated authenticated user', async () => {
    await request(app).get('/api/hunts').set('Authorization', auth).expect(200, []);
  });

  it('preserves persisted statuses and repository ordering in the list response', async () => {
    const statuses = ['draft', 'published', 'active', 'paused', 'cancelled', 'finished'] as const;
    const hunts = statuses.map((status, index) => ({
      ...hunt,
      id: `hunt-${index}`,
      status,
      updatedAt: new Date(now.getTime() - index * 1000),
      createdAt: new Date(now.getTime() - index * 100),
      huntRoles: ['organizer'],
    }));
    mocks.findHuntsForUser.mockResolvedValueOnce(hunts);

    const response = await request(app).get('/api/hunts').set('Authorization', auth).expect(200);
    expect(response.body.map(({ id, status }: { id: string; status: string }) => ({ id, status }))).toEqual(
      hunts.map(({ id, status }) => ({ id, status })),
    );
  });

  it.each([['creator'], ['organizer']])('allows an organization member with %s capability to create a draft', async (role) => {
    mocks.findUserById.mockResolvedValue({ ...user, roles: ['participant', role] });
    const response = await request(app).post('/api/hunts').set('Authorization', auth)
      .send({ organizationId: 'org-1', name: '  City Hunt  ', status: 'active' }).expect(201);
    expect(response.body.status).toBe('draft');
    expect(mocks.createHunt).toHaveBeenCalledWith({
      organizationId: 'org-1', createdByUserId: user.id, name: 'City Hunt',
    });
  });

  it('rejects participant-only users and unrelated creators', async () => {
    mocks.findUserById.mockResolvedValueOnce({ ...user, roles: ['participant'] });
    await request(app).post('/api/hunts').set('Authorization', auth)
      .send({ organizationId: 'org-1', name: 'Hunt' }).expect(403);
    mocks.isMember.mockResolvedValueOnce(false);
    await request(app).post('/api/hunts').set('Authorization', auth)
      .send({ organizationId: 'org-1', name: 'Hunt' }).expect(403);
  });

  it('validates create input and reports an unknown organization', async () => {
    await request(app).post('/api/hunts').set('Authorization', auth)
      .send({ organizationId: 'org-1', name: '  ' }).expect(400);
    mocks.findOrganizationById.mockResolvedValueOnce(null);
    await request(app).post('/api/hunts').set('Authorization', auth)
      .send({ organizationId: 'missing', name: 'Hunt' }).expect(404);
  });

  it('allows organizers and supervisors to read but rejects unrelated users', async () => {
    await request(app).get('/api/hunts/hunt-1').set('Authorization', auth).expect(200);
    mocks.hasHuntRole.mockImplementation((_h, _u, role) => role === 'supervisor');
    await request(app).get('/api/hunts/hunt-1').set('Authorization', auth).expect(200);
    mocks.hasHuntRole.mockResolvedValue(false);
    await request(app).get('/api/hunts/hunt-1').set('Authorization', auth).expect(403);
  });

  it('returns 404 for an unknown Hunt', async () => {
    mocks.findHuntById.mockResolvedValue(null);
    await request(app).get('/api/hunts/missing').set('Authorization', auth).expect(404);
  });

  it('lets only its organizer rename a draft', async () => {
    await request(app).patch('/api/hunts/hunt-1').set('Authorization', auth)
      .send({ name: ' Renamed ' }).expect(200);
    expect(mocks.updateDraft).toHaveBeenCalledWith('hunt-1', 'Renamed');
    mocks.hasHuntRole.mockResolvedValue(false);
    await request(app).patch('/api/hunts/hunt-1').set('Authorization', auth)
      .send({ name: 'No' }).expect(403);
  });

  it('rejects supervisor draft updates and direct status patches', async () => {
    mocks.hasHuntRole.mockImplementation((_h, _u, role) => role === 'supervisor');
    await request(app).patch('/api/hunts/hunt-1').set('Authorization', auth)
      .send({ name: 'No' }).expect(403);
    mocks.hasHuntRole.mockResolvedValue(true);
    await request(app).patch('/api/hunts/hunt-1').set('Authorization', auth)
      .send({ name: 'No', status: 'published' }).expect(400);
  });

  it('rejects draft updates after publication, including a concurrent state change', async () => {
    mocks.findHuntById.mockResolvedValueOnce({ ...hunt, status: 'published' });
    await request(app).patch('/api/hunts/hunt-1').set('Authorization', auth)
      .send({ name: 'No' }).expect(409, { error: 'invalid_hunt_state' });
    mocks.updateDraft.mockResolvedValueOnce(null);
    await request(app).patch('/api/hunts/hunt-1').set('Authorization', auth)
      .send({ name: 'No' }).expect(409, { error: 'invalid_hunt_state' });
  });

  it.each([
    ['publish', ['draft'], 'published'],
    ['start', ['published'], 'active'],
    ['pause', ['active'], 'paused'],
    ['resume', ['paused'], 'active'],
    ['finish', ['active', 'paused'], 'finished'],
    ['cancel', ['draft', 'published', 'active', 'paused'], 'cancelled'],
  ])('applies the %s lifecycle transition conditionally', async (action, from, to) => {
    await request(app).post(`/api/hunts/hunt-1/${action}`).set('Authorization', auth).expect(200);
    expect(mocks.transitionStatus).toHaveBeenCalledWith({ id: 'hunt-1', from, to });
  });

  it.each([
    ['start', 'draft'], ['pause', 'published'], ['publish', 'paused'], ['start', 'finished'],
    ['start', 'cancelled'], ['publish', 'published'], ['finish', 'finished'],
  ])('rejects %s from %s with a conflict', async (action, status) => {
    mocks.findHuntById.mockResolvedValueOnce({ ...hunt, status });
    mocks.transitionStatus.mockResolvedValueOnce(null);
    await request(app).post(`/api/hunts/hunt-1/${action}`).set('Authorization', auth)
      .expect(409, { error: 'invalid_hunt_state' });
  });

  it('prevents supervisors and unrelated global creators from lifecycle control', async () => {
    mocks.hasHuntRole.mockResolvedValue(false);
    await request(app).post('/api/hunts/hunt-1/publish').set('Authorization', auth).expect(403);
    expect(mocks.transitionStatus).not.toHaveBeenCalled();
  });
});
