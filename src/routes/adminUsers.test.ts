import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(), list: vi.fn(), provision: vi.fn(), professionalList: vi.fn(),
  professionalProvision: vi.fn(), createRefreshToken: vi.fn(), setAccountStatus: vi.fn(),
}));
vi.mock('../models/ProfessionalProvisioning.js', () => {
  class ProfessionalGuestPromotionError extends Error {}
  class ProfessionalActivationAlreadyPendingError extends Error {}
  return {
    ProfessionalGuestPromotionError, ProfessionalActivationAlreadyPendingError,
    ProfessionalProvisioning: {
      list: mocks.professionalList, provision: mocks.professionalProvision, activate: vi.fn(),
    },
  };
});
vi.mock('../models/User.js', () => ({
  LastActiveAdminError: class LastActiveAdminError extends Error {},
  User: { findById: mocks.findById, setAccountStatus: mocks.setAccountStatus },
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));
vi.mock('../models/AdminProvisioning.js', () => {
  class GuestPromotionError extends Error {}
  class ActivationAlreadyPendingError extends Error {}
  return {
    GuestPromotionError, ActivationAlreadyPendingError,
    AdminProvisioning: { list: mocks.list, provision: mocks.provision, activate: vi.fn() },
  };
});
vi.mock('../models/RefreshToken.js', () => ({
  RefreshToken: { create: mocks.createRefreshToken },
}));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const user = (roles: string[], overrides = {}) => ({
  id: '0aa12189-77d8-4aa9-9d37-57db263de6cf', email: 'user@example.com',
  passwordHash: 'secret-hash', role: 'participant', roles, name: 'User', isGuest: false,
  tedixUserId: null, accountStatus: 'active', createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});
const bearer = () => `Bearer ${signJwt({ sub: user([]).id, type: 'access' })}`;

describe('Admin user provisioning API', () => {
  const app = createApp();
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue(user(['admin']));
    mocks.list.mockResolvedValue([]);
    mocks.professionalList.mockResolvedValue([]);
    mocks.setAccountStatus.mockImplementation(async (_id, accountStatus) =>
      user(['participant'], { accountStatus }));
  });

  it('requires the authoritative Admin role for listing and provisioning', async () => {
    mocks.findById.mockResolvedValue(user(['participant']));
    await request(app).get('/api/admin/users?role=admin').set('Authorization', bearer()).expect(403);
    await request(app).post('/api/admin/users/admin').set('Authorization', bearer())
      .send({ email: 'second@example.com' }).expect(403);
    await request(app).post('/api/admin/users/professional').set('Authorization', bearer())
      .send({ email: 'creator@example.com', role: 'creator' }).expect(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('provisions a Creator without requiring an organization', async () => {
    mocks.professionalProvision.mockResolvedValue({
      user: user(['creator'], { passwordHash: null }), role: 'creator',
      activationRequired: true, activationToken: 'creator-token',
      activationExpiresAt: new Date('2026-01-02T00:00:00Z'),
    });
    const response = await request(app).post('/api/admin/users/professional')
      .set('Authorization', bearer())
      .send({ email: ' Creator@Example.com ', role: 'creator' }).expect(201);
    expect(mocks.professionalProvision).toHaveBeenCalledWith(expect.objectContaining({
      email: ' Creator@Example.com ', role: 'creator', createdBy: user([]).id,
    }));
    expect(response.body).toMatchObject({ role: 'creator', activationRequired: true });
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  it('requires an organization name for Organizer and rejects unsupported fields', async () => {
    await request(app).post('/api/admin/users/professional').set('Authorization', bearer())
      .send({ email: 'organizer@example.com', role: 'organizer' }).expect(400);
    await request(app).post('/api/admin/users/professional').set('Authorization', bearer())
      .send({ email: 'creator@example.com', role: 'creator', password: 'nope' }).expect(400);
    expect(mocks.professionalProvision).not.toHaveBeenCalled();
  });

  it.each(['organizer', 'creator'])('lists safe %s identities with role-specific state', async (role) => {
    mocks.professionalList.mockResolvedValue([user([role], { activationState: 'pending' })]);
    const response = await request(app).get(`/api/admin/users?role=${role}`)
      .set('Authorization', bearer()).expect(200);
    expect(mocks.professionalList).toHaveBeenCalledWith(role);
    expect(response.body[0]).toMatchObject({ activationState: 'pending', roles: [role] });
    expect(response.body[0]).not.toHaveProperty('passwordHash');
  });

  it('lists only the safe Admin representation', async () => {
    mocks.list.mockResolvedValue([user(['admin'], {
      activationState: 'not_required', activationTokenHash: 'never-return-this',
    })]);
    const response = await request(app).get('/api/admin/users?role=admin')
      .set('Authorization', bearer()).expect(200);
    expect(response.body[0]).toMatchObject({ roles: ['admin'], activationState: 'not_required' });
    expect(response.body[0]).not.toHaveProperty('passwordHash');
    expect(response.body[0]).not.toHaveProperty('activationTokenHash');
  });

  it('returns a one-time activation credential for a passwordless provision', async () => {
    mocks.provision.mockResolvedValue({
      user: user(['admin', 'participant'], { passwordHash: null }),
      activationRequired: true, activationToken: 'plaintext-once',
      activationExpiresAt: new Date('2026-01-02T00:00:00Z'),
    });
    const response = await request(app).post('/api/admin/users/admin')
      .set('Authorization', bearer())
      .send({ email: ' SECOND@EXAMPLE.COM ', name: 'Second' }).expect(201);
    expect(mocks.provision).toHaveBeenCalledWith(
      ' SECOND@EXAMPLE.COM ', 'Second', user([]).id,
    );
    expect(response.body).toMatchObject({ activationRequired: true, activationToken: 'plaintext-once' });
    expect(response.body.user.roles).toEqual(['admin', 'participant']);
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  it('idempotently represents a password-backed Admin without activation', async () => {
    mocks.provision.mockResolvedValue({ user: user(['admin', 'creator']), activationRequired: false });
    const response = await request(app).post('/api/admin/users/admin')
      .set('Authorization', bearer()).send({ email: 'user@example.com' }).expect(200);
    expect(response.body).toMatchObject({ activationRequired: false });
    expect(response.body).not.toHaveProperty('activationToken');
    expect(response.body.user.roles).toEqual(['admin', 'creator']);
  });

  it('blocks and unblocks another identity idempotently without changing roles', async () => {
    const targetId = '86ea867c-8058-4d53-a2ab-09ba2250f423';
    const blocked = await request(app).post(`/api/admin/users/${targetId}/block`)
      .set('Authorization', bearer()).expect(200);
    const unblocked = await request(app).post(`/api/admin/users/${targetId}/unblock`)
      .set('Authorization', bearer()).expect(200);
    await request(app).post(`/api/admin/users/${targetId}/block`)
      .set('Authorization', bearer()).expect(200);

    expect(mocks.setAccountStatus.mock.calls).toEqual([
      [targetId, 'blocked'], [targetId, 'active'], [targetId, 'blocked'],
    ]);
    expect(blocked.body.user).toMatchObject({ accountStatus: 'blocked', roles: ['participant'] });
    expect(unblocked.body.user).toMatchObject({ accountStatus: 'active', roles: ['participant'] });
  });

  it('prevents self-block and non-Admin status changes', async () => {
    await request(app).post(`/api/admin/users/${user([]).id}/block`)
      .set('Authorization', bearer()).expect(409, { error: 'self_block_not_allowed' });
    mocks.findById.mockResolvedValue(user(['participant']));
    await request(app).post('/api/admin/users/another-user/block')
      .set('Authorization', bearer()).expect(403);
    expect(mocks.setAccountStatus).not.toHaveBeenCalled();
  });

  it('rejects blocking the last active Admin', async () => {
    const { LastActiveAdminError } = await import('../models/User.js');
    mocks.setAccountStatus.mockRejectedValue(new LastActiveAdminError());
    await request(app).post('/api/admin/users/last-admin/block')
      .set('Authorization', bearer()).expect(409, { error: 'last_active_admin' });
  });
});
