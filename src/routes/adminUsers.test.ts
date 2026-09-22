import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(), list: vi.fn(), provision: vi.fn(), createRefreshToken: vi.fn(),
}));
vi.mock('../models/User.js', () => ({
  User: { findById: mocks.findById },
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
  tedixUserId: null, createdAt: new Date('2026-01-01T00:00:00Z'), ...overrides,
});
const bearer = () => `Bearer ${signJwt({ sub: user([]).id, type: 'access' })}`;

describe('Admin user provisioning API', () => {
  const app = createApp();
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue(user(['admin']));
    mocks.list.mockResolvedValue([]);
  });

  it('requires the authoritative Admin role for listing and provisioning', async () => {
    mocks.findById.mockResolvedValue(user(['participant']));
    await request(app).get('/api/admin/users?role=admin').set('Authorization', bearer()).expect(403);
    await request(app).post('/api/admin/users/admin').set('Authorization', bearer())
      .send({ email: 'second@example.com' }).expect(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
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
});
