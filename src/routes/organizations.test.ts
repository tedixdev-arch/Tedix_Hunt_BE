import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(),
  createOrganization: vi.fn(),
  findOrganizationById: vi.fn(),
  findOrganizationsForUser: vi.fn(),
  isOwner: vi.fn(),
  isMember: vi.fn(),
  updateOrganization: vi.fn(),
}));

vi.mock('../models/User.js', () => ({
  User: { findById: mocks.findUserById },
}));
vi.mock('../models/Organization.js', () => ({
  Organization: {
    create: mocks.createOrganization,
    findById: mocks.findOrganizationById,
    findByOwnerOrMember: mocks.findOrganizationsForUser,
    isOwner: mocks.isOwner,
    isMember: mocks.isMember,
    update: mocks.updateOrganization,
  },
}));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const createdAt = new Date('2026-01-02T03:04:05Z');
const currentUser = {
  id: 'user-1',
  email: 'creator@example.com',
  passwordHash: null,
  role: 'participant' as const,
  roles: ['participant', 'creator'],
  name: 'Creator',
  isGuest: false,
  tedixUserId: null,
  createdAt,
};
const organization = {
  id: 'org-1',
  name: 'Example',
  description: null,
  owner: 'owner-1',
  members: ['member-1'],
  createdAt,
};
const authorization = `Bearer ${signJwt({ sub: currentUser.id, type: 'access' })}`;

describe('organization authorization', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(currentUser);
    mocks.findOrganizationById.mockResolvedValue(organization);
    mocks.findOrganizationsForUser.mockResolvedValue([]);
    mocks.isOwner.mockResolvedValue(false);
    mocks.isMember.mockResolvedValue(false);
  });

  it('allows owners and members to read an organization but rejects unrelated users', async () => {
    mocks.isOwner.mockResolvedValueOnce(true);
    await request(app).get('/api/organizations/org-1').set('Authorization', authorization).expect(200);

    mocks.isMember.mockResolvedValueOnce(true);
    await request(app).get('/api/organizations/org-1').set('Authorization', authorization).expect(200);

    await request(app)
      .get('/api/organizations/org-1')
      .set('Authorization', authorization)
      .expect(403, { error: 'forbidden' });
  });

  it('lists only organizations returned by the owner-or-member relationship query', async () => {
    mocks.findOrganizationsForUser.mockResolvedValue([organization]);

    const response = await request(app)
      .get('/api/organizations')
      .set('Authorization', authorization)
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(mocks.findOrganizationsForUser).toHaveBeenCalledWith(currentUser.id);
  });

  it('creates an organization with the authenticated user as owner and member', async () => {
    mocks.createOrganization.mockResolvedValue({
      ...organization,
      owner: currentUser.id,
      members: [currentUser.id],
    });

    await request(app)
      .post('/api/organizations')
      .set('Authorization', authorization)
      .send({ name: 'Example' })
      .expect(201);

    expect(mocks.createOrganization).toHaveBeenCalledWith({
      name: 'Example',
      description: undefined,
      owner: currentUser.id,
      members: [currentUser.id],
    });
  });

  it('allows only the owner to update an organization', async () => {
    mocks.updateOrganization.mockResolvedValue({ ...organization, name: 'Changed' });
    mocks.isOwner.mockResolvedValueOnce(true);
    await request(app)
      .patch('/api/organizations/org-1')
      .set('Authorization', authorization)
      .send({ name: 'Changed' })
      .expect(200);

    mocks.isMember.mockResolvedValueOnce(true);
    await request(app)
      .patch('/api/organizations/org-1')
      .set('Authorization', authorization)
      .send({ name: 'Member change' })
      .expect(403, { error: 'forbidden' });

    await request(app)
      .patch('/api/organizations/org-1')
      .set('Authorization', authorization)
      .send({ name: 'Unrelated change' })
      .expect(403, { error: 'forbidden' });

    expect(mocks.updateOrganization).toHaveBeenCalledOnce();
  });

  it('requires canonical creator capability to create or update organizations', async () => {
    mocks.findUserById.mockResolvedValue({ ...currentUser, roles: ['participant'], role: 'creator' });
    await request(app)
      .post('/api/organizations')
      .set('Authorization', authorization)
      .send({ name: 'Example' })
      .expect(403, { error: 'forbidden' });
    await request(app)
      .patch('/api/organizations/org-1')
      .set('Authorization', authorization)
      .send({ name: 'Changed' })
      .expect(403, { error: 'forbidden' });
  });
});
