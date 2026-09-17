import request from 'supertest';
import { beforeEach, describe, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(),
  createOrganization: vi.fn(),
  findOrganizationById: vi.fn(),
  findOrganizationsForUser: vi.fn(),
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
  });

  it('allows owners and members to read an organization but rejects unrelated users', async () => {
    mocks.findOrganizationById.mockResolvedValueOnce({ ...organization, owner: currentUser.id });
    await request(app).get('/api/organizations/org-1').set('Authorization', authorization).expect(200);

    mocks.findOrganizationById.mockResolvedValueOnce({
      ...organization,
      members: [currentUser.id],
    });
    await request(app).get('/api/organizations/org-1').set('Authorization', authorization).expect(200);

    await request(app)
      .get('/api/organizations/org-1')
      .set('Authorization', authorization)
      .expect(403, { error: 'forbidden' });
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
