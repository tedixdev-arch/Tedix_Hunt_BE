import request from 'supertest';
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  findUser: vi.fn(),
  findUserById: vi.fn(),
  changePasswordAndRevokeSessions: vi.fn(),
  createRefreshToken: vi.fn(),
  consumeRefreshToken: vi.fn(),
  deleteRefreshToken: vi.fn(),
  organizationsForUser: vi.fn(),
  activateOrganizer: vi.fn(),
  activateAdmin: vi.fn(),
  activateProfessional: vi.fn(),
}));

vi.mock('../models/User.js', () => ({
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
  User: {
    create: mocks.createUser,
    findOne: mocks.findUser,
    findById: mocks.findUserById,
    changePasswordAndRevokeSessions: mocks.changePasswordAndRevokeSessions,
  },
}));
vi.mock('../models/RefreshToken.js', () => ({
  RefreshToken: {
    create: mocks.createRefreshToken,
    consume: mocks.consumeRefreshToken,
    deleteByToken: mocks.deleteRefreshToken,
  },
}));
vi.mock('../models/Organization.js', () => ({
  Organization: { findByOwnerOrMember: mocks.organizationsForUser },
}));
vi.mock('../models/OrganizerApplication.js', () => ({
  OrganizerApplications: { activate: mocks.activateOrganizer },
}));
vi.mock('../models/AdminProvisioning.js', () => ({
  AdminProvisioning: { activate: mocks.activateAdmin, list: vi.fn(), provision: vi.fn() },
  GuestPromotionError: class extends Error {},
  ActivationAlreadyPendingError: class extends Error {},
}));
vi.mock('../models/ProfessionalProvisioning.js', () => ({
  ProfessionalProvisioning: { activate: mocks.activateProfessional, list: vi.fn(), provision: vi.fn() },
  ProfessionalGuestPromotionError: class extends Error {},
  ProfessionalActivationAlreadyPendingError: class extends Error {},
}));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const createdAt = new Date('2026-01-02T03:04:05Z');
const registeredUser = {
  id: '7dc65d7e-cd31-4205-b92d-c716a7ae494a',
  email: 'person@example.com',
  passwordHash: '$2a$10$database-hash',
  role: 'creator',
  roles: ['creator'],
  name: 'Person',
  isGuest: false,
  tedixUserId: null,
  createdAt,
};

describe('user account API', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUser.mockResolvedValue(null);
    mocks.createUser.mockResolvedValue(registeredUser);
    mocks.createRefreshToken.mockResolvedValue({});
    mocks.consumeRefreshToken.mockResolvedValue(null);
    mocks.deleteRefreshToken.mockResolvedValue(false);
    mocks.organizationsForUser.mockResolvedValue([]);
    mocks.activateOrganizer.mockResolvedValue(null);
    mocks.activateAdmin.mockResolvedValue(null);
    mocks.activateProfessional.mockResolvedValue(null);
    mocks.changePasswordAndRevokeSessions.mockResolvedValue(undefined);
  });

  it.each(['organizer', 'creator'] as const)('directly activates a provisioned %s', async (role) => {
    mocks.activateProfessional.mockResolvedValue({ ...registeredUser, roles: [role] });
    const path = role === 'organizer' ? '/api/auth/organizer/activate-direct' : '/api/auth/creator/activate';
    const response = await request(app).post(path)
      .send({ token: `${role}-token`, password: 'secure-password' }).expect(200);
    expect(mocks.activateProfessional).toHaveBeenCalledWith(
      role, expect.stringMatching(/^[a-f0-9]{64}$/), expect.any(String),
    );
    expect(response.body.user.roles).toEqual([role]);
    expect(response.body.tokens.accessToken).toEqual(expect.any(String));
  });

  it('activates an organizer once, hashes its password, and issues normal tokens', async () => {
    const organizer = { ...registeredUser, role: 'organizer', roles: ['organizer'] };
    mocks.activateOrganizer.mockResolvedValue(organizer);
    const response = await request(app).post('/api/auth/organizer/activate')
      .send({ token: 'one-time-token', password: 'secure-password' }).expect(200);

    const [tokenHash, passwordHash] = mocks.activateOrganizer.mock.calls[0];
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toBe('one-time-token');
    await expect(bcrypt.compare('secure-password', passwordHash)).resolves.toBe(true);
    expect(response.body.user.roles).toContain('organizer');
    expect(response.body.tokens).toEqual({
      accessToken: expect.any(String), refreshToken: expect.any(String),
    });
  });

  it('activates an Admin once with a hashed password and normal session tokens', async () => {
    const admin = { ...registeredUser, passwordHash: '$stored', roles: ['participant', 'admin'] };
    mocks.activateAdmin.mockResolvedValue(admin);
    const response = await request(app).post('/api/auth/admin/activate')
      .send({ token: 'admin-one-time-token', password: 'secure-password' }).expect(200);
    const [tokenHash, passwordHash] = mocks.activateAdmin.mock.calls[0];
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toBe('admin-one-time-token');
    await expect(bcrypt.compare('secure-password', passwordHash)).resolves.toBe(true);
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.user.roles).toContain('admin');
    expect(response.body.tokens).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String) });
  });

  it.each(['invalid', 'expired', 'consumed'])('uniformly rejects an %s Admin activation', async () => {
    await request(app).post('/api/auth/admin/activate')
      .send({ token: 'unusable-token', password: 'secure-password' })
      .expect(401, { error: 'invalid_or_expired_activation' });
  });

  it.each(['invalid', 'expired', 'already-used'])('rejects an %s activation token', async () => {
    await request(app).post('/api/auth/organizer/activate')
      .send({ token: 'unusable-token', password: 'secure-password' })
      .expect(401, { error: 'invalid_or_expired_activation' });
  });

  it('hashes a registered user password and never returns its hash', async () => {
    const response = await request(app)
      .post('/api/auth/participant/register')
      .send({ email: 'person@example.com', password: 'plain-secret', name: 'Person' })
      .expect(201);

    const createInput = mocks.createUser.mock.calls[0][0];
    expect(createInput.role).toBe('participant');
    expect(createInput.passwordHash).not.toBe('plain-secret');
    await expect(bcrypt.compare('plain-secret', createInput.passwordHash)).resolves.toBe(true);
    expect(response.body.user).toMatchObject({
      isGuest: false,
      role: 'creator',
      roles: ['creator'],
    });
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects an existing email cleanly', async () => {
    mocks.findUser.mockResolvedValue(registeredUser);

    await request(app)
      .post('/api/auth/participant/register')
      .send({ email: 'person@example.com', password: 'plain-secret' })
      .expect(409, { error: 'email_taken' });
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('does not expose public privileged-role assignment endpoints', async () => {
    await request(app)
      .post('/api/auth/creator/register')
      .send({ email: 'person@example.com', password: 'plain-secret' })
      .expect(404);
    await request(app).post('/api/auth/roles').send({ role: 'admin' }).expect(404);
  });

  it('logs a creator in with valid credentials and rejects an invalid password', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 4);
    mocks.findUser.mockResolvedValue({ ...registeredUser, passwordHash });

    const success = await request(app)
      .post('/api/auth/creator/login')
      .send({ email: 'PERSON@example.com', password: 'correct-password' })
      .expect(200);
    expect(success.body.tokens).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    expect(mocks.findUser).toHaveBeenCalledWith({
      email: 'PERSON@example.com',
      role: 'creator',
    });

    await request(app)
      .post('/api/auth/creator/login')
      .send({ email: 'person@example.com', password: 'wrong-password' })
      .expect(401, { error: 'invalid_credentials' });
  });

  it('logs in a creator whose legacy role remains participant', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 4);
    mocks.findUser.mockResolvedValue({
      ...registeredUser,
      role: 'participant',
      roles: ['participant', 'creator'],
      passwordHash,
    });

    const response = await request(app)
      .post('/api/auth/creator/login')
      .send({ email: 'person@example.com', password: 'correct-password' })
      .expect(200);

    expect(mocks.findUser).toHaveBeenCalledWith({ email: 'person@example.com', role: 'creator' });
    expect(response.body.user).toMatchObject({
      role: 'participant',
      roles: ['participant', 'creator'],
    });
  });

  describe('organizer login', () => {
    const password = 'organizer-password';

    const organizer = async (roles: string[], role = 'participant') => ({
      ...registeredUser,
      role,
      roles,
      passwordHash: await bcrypt.hash(password, 4),
    });

    it('authenticates organizer-only accounts and returns the public user and normal tokens', async () => {
      const user = await organizer(['organizer']);
      mocks.findUser.mockResolvedValue(user);

      const response = await request(app)
        .post('/api/auth/organizer/login')
        .send({ email: ' PERSON@EXAMPLE.COM ', password })
        .expect(200);

      expect(mocks.findUser).toHaveBeenCalledWith({ email: ' PERSON@EXAMPLE.COM ' });
      expect(response.body.user).toMatchObject({
        id: user.id,
        role: 'participant',
        roles: ['organizer'],
      });
      expect(response.body.user).not.toHaveProperty('passwordHash');
      expect(response.body.tokens).toEqual({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
      expect(mocks.createRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ user: user.id, token: response.body.tokens.refreshToken }),
      );
    });

    it.each([
      ['creator legacy role', ['creator', 'organizer'], 'creator'],
      ['admin legacy role', ['admin', 'organizer'], 'creator'],
    ])('authenticates a multi-role organizer with a %s', async (_label, roles, role) => {
      mocks.findUser.mockResolvedValue(await organizer(roles, role));

      const response = await request(app)
        .post('/api/auth/organizer/login')
        .send({ email: registeredUser.email, password })
        .expect(200);

      expect(response.body.user).toMatchObject({ role, roles });
    });

    it.each([
      ['creator', ['creator']],
      ['participant', ['participant']],
      ['admin', ['admin']],
      ['guest', []],
    ])('rejects a %s account without the organizer capability', async (_label, roles) => {
      mocks.findUser.mockResolvedValue(await organizer(roles));

      await request(app)
        .post('/api/auth/organizer/login')
        .send({ email: registeredUser.email, password })
        .expect(401, { error: 'invalid_credentials' });

      expect(mocks.createRefreshToken).not.toHaveBeenCalled();
    });

    it('uses the same invalid-credentials response for wrong passwords and unknown accounts', async () => {
      mocks.findUser
        .mockResolvedValueOnce(await organizer(['organizer']))
        .mockResolvedValueOnce(null);

      await request(app)
        .post('/api/auth/organizer/login')
        .send({ email: registeredUser.email, password: 'wrong-password' })
        .expect(401, { error: 'invalid_credentials' });
      await request(app)
        .post('/api/auth/organizer/login')
        .send({ email: 'unknown@example.com', password })
        .expect(401, { error: 'invalid_credentials' });
    });

    it.each([
      [{ password }],
      [{ email: registeredUser.email }],
    ])('rejects missing credentials with invalid_input', async (body) => {
      await request(app)
        .post('/api/auth/organizer/login')
        .send(body)
        .expect(400, { error: 'invalid_input' });

      expect(mocks.findUser).not.toHaveBeenCalled();
    });

    it('uses the existing refresh-token rotation flow for organizer sessions', async () => {
      const user = await organizer(['organizer']);
      mocks.findUser.mockResolvedValue(user);
      const login = await request(app)
        .post('/api/auth/organizer/login')
        .send({ email: registeredUser.email, password })
        .expect(200);

      mocks.consumeRefreshToken.mockResolvedValue({
        id: 'organizer-refresh-id',
        user: user.id,
        token: login.body.tokens.refreshToken,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt,
      });
      mocks.findUserById.mockResolvedValue(user);

      const refreshed = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: login.body.tokens.refreshToken })
        .expect(200);

      expect(refreshed.body).toEqual({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
    });
  });

  describe('admin login', () => {
    const password = 'admin-password';
    const comparePassword = vi.spyOn(bcrypt, 'compare');

    const admin = async (roles: string[], role = 'participant') => ({
      ...registeredUser,
      role,
      roles,
      passwordHash: await bcrypt.hash(password, 4),
    });

    it('authenticates an authoritative admin and returns the public user and normal tokens', async () => {
      const user = await admin(['participant', 'admin']);
      mocks.findUser.mockResolvedValue(user);

      const response = await request(app)
        .post('/api/auth/admin/login')
        .send({ email: ' ADMIN@EXAMPLE.COM ', password })
        .expect(200);

      expect(mocks.findUser).toHaveBeenCalledWith({ email: 'admin@example.com' });
      expect(response.body.user).toMatchObject({
        id: user.id,
        role: 'participant',
        roles: ['participant', 'admin'],
      });
      expect(response.body.user).not.toHaveProperty('passwordHash');
      expect(response.body.tokens).toEqual({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
      });
      expect(mocks.createRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ user: user.id, token: response.body.tokens.refreshToken }),
      );
    });

    it.each([
      ['legacy admin without an authoritative admin role', ['participant'], 'admin'],
      ['participant', ['participant'], 'participant'],
      ['organizer', ['organizer'], 'participant'],
      ['creator', ['creator'], 'creator'],
    ])('rejects a %s account', async (_label, roles, role) => {
      mocks.findUser.mockResolvedValue(await admin(roles, role));

      await request(app)
        .post('/api/auth/admin/login')
        .send({ email: registeredUser.email, password })
        .expect(401, { error: 'invalid_credentials' });

      expect(mocks.createRefreshToken).not.toHaveBeenCalled();
    });

    it('uses the same invalid-credentials response for wrong passwords and unknown accounts', async () => {
      mocks.findUser
        .mockResolvedValueOnce(await admin(['admin']))
        .mockResolvedValueOnce(null);

      await request(app)
        .post('/api/auth/admin/login')
        .send({ email: registeredUser.email, password: 'wrong-password' })
        .expect(401, { error: 'invalid_credentials' });
      await request(app)
        .post('/api/auth/admin/login')
        .send({ email: 'unknown@example.com', password })
        .expect(401, { error: 'invalid_credentials' });
    });

    it.each([
      [{ password }],
      [{ email: registeredUser.email }],
    ])('rejects missing credentials with invalid_input', async (body) => {
      await request(app)
        .post('/api/auth/admin/login')
        .send(body)
        .expect(400, { error: 'invalid_input' });

      expect(mocks.findUser).not.toHaveBeenCalled();
    });

    it.each([
      [{ email: {}, password }],
      [{ email: 42, password }],
      [{ email: registeredUser.email, password: {} }],
      [{ email: registeredUser.email, password: 42 }],
      [{ email: '   ', password }],
    ])('rejects malformed credential values with invalid_input', async (body) => {
      await request(app)
        .post('/api/auth/admin/login')
        .send(body)
        .expect(400, { error: 'invalid_input' });

      expect(mocks.findUser).not.toHaveBeenCalled();
      expect(comparePassword).not.toHaveBeenCalled();
    });
  });

  it('maps a database uniqueness race to the same safe response', async () => {
    mocks.createUser.mockRejectedValue(Object.assign(new Error('private database detail'), { code: '23505' }));

    const response = await request(app)
      .post('/api/auth/participant/register')
      .send({ email: 'person@example.com', password: 'plain-secret' })
      .expect(409);

    expect(response.body).toEqual({ error: 'email_taken' });
    expect(JSON.stringify(response.body)).not.toContain('database');
  });

  it('does not expose unexpected PostgreSQL errors', async () => {
    mocks.createUser.mockRejectedValue(
      Object.assign(new Error('connection to DATABASE_URL failed'), { code: '08006' }),
    );

    const response = await request(app)
      .post('/api/auth/participant/register')
      .send({ email: 'person@example.com', password: 'plain-secret' })
      .expect(500);

    expect(response.body).toEqual({
      error: 'internal_server_error',
      message: 'An unexpected error occurred.',
    });
    expect(JSON.stringify(response.body)).not.toContain('DATABASE_URL');
  });

  it('retrieves an existing user without exposing account secrets', async () => {
    mocks.findUserById.mockResolvedValue(registeredUser);
    const token = signJwt({ sub: registeredUser.id, type: 'access' });

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({
      id: registeredUser.id,
      isGuest: false,
      roles: ['creator'],
    });
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('refreshToken');
  });

  describe('change password', () => {
    const currentPassword = 'current-password';
    const newPassword = 'replacement-password';

    const authenticatedRequest = (user: any = registeredUser, body: Record<string, unknown> = {
      currentPassword,
      newPassword,
    }) => {
      mocks.findUserById.mockResolvedValue(user);
      const token = signJwt({ sub: user.id, type: 'access' });
      return request(app).post('/api/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
    };

    it('changes the authenticated user password to a bcrypt hash without returning credentials', async () => {
      const passwordHash = await bcrypt.hash(currentPassword, 4);
      const response = await authenticatedRequest({ ...registeredUser, passwordHash }).expect(200);

      expect(response.body).toEqual({ message: 'Password changed successfully.' });
      const [userId, newHash] = mocks.changePasswordAndRevokeSessions.mock.calls[0];
      expect(userId).toBe(registeredUser.id);
      expect(newHash).not.toBe(newPassword);
      await expect(bcrypt.compare(newPassword, newHash)).resolves.toBe(true);
      await expect(bcrypt.compare(currentPassword, newHash)).resolves.toBe(false);
      expect(JSON.stringify(response.body)).not.toContain(currentPassword);
      expect(JSON.stringify(response.body)).not.toContain(newPassword);
    });

    it('rejects wrong current credentials without modifying the password', async () => {
      const passwordHash = await bcrypt.hash(currentPassword, 4);
      const response = await authenticatedRequest(
        { ...registeredUser, passwordHash },
        { currentPassword: 'wrong-password', newPassword },
      ).expect(401, { error: 'invalid_credentials' });

      expect(mocks.changePasswordAndRevokeSessions).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body)).not.toContain('wrong-password');
      expect(JSON.stringify(response.body)).not.toContain(newPassword);
    });

    it.each([
      ['guest', { ...registeredUser, isGuest: true }],
      ['passwordless user', { ...registeredUser, passwordHash: null }],
    ])('rejects a %s with the same safe error', async (_label, user) => {
      await authenticatedRequest(user).expect(401, { error: 'invalid_credentials' });
      expect(mocks.changePasswordAndRevokeSessions).not.toHaveBeenCalled();
    });

    it('cannot select another account with request fields', async () => {
      const passwordHash = await bcrypt.hash(currentPassword, 4);
      await authenticatedRequest(
        { ...registeredUser, passwordHash },
        { currentPassword, newPassword, userId: 'another-user', email: 'other@example.com', role: 'admin' },
      ).expect(200);

      expect(mocks.changePasswordAndRevokeSessions).toHaveBeenCalledWith(
        registeredUser.id,
        expect.any(String),
      );
    });

    it.each([
      [{ currentPassword: '', newPassword }],
      [{ currentPassword: 123, newPassword }],
      [{ currentPassword, newPassword: 'short' }],
      [{ currentPassword, newPassword: 123 }],
    ])('rejects invalid input safely', async (body) => {
      const response = await authenticatedRequest(registeredUser, body).expect(400, { error: 'invalid_input' });
      expect(mocks.changePasswordAndRevokeSessions).not.toHaveBeenCalled();
      for (const password of [body.currentPassword, body.newPassword]) {
        if (String(password)) expect(JSON.stringify(response.body)).not.toContain(String(password));
      }
    });
  });

  it('rejects malformed and expired access tokens without leaking JWT details', async () => {
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer definitely-not-a-jwt')
      .expect(401, { error: 'unauthorized' });

    const expired = signJwt(
      { sub: registeredUser.id, type: 'access' },
      { expiresIn: -1 },
    );
    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${expired}`)
      .expect(401);
    expect(response.body).toEqual({ error: 'unauthorized' });
    expect(mocks.findUserById).not.toHaveBeenCalled();
  });

  it('does not accept another signed token type as an access token', async () => {
    const nonAccessToken = signJwt({ sub: registeredUser.id, type: 'refresh' });
    await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${nonAccessToken}`)
      .expect(401, { error: 'unauthorized' });
    expect(mocks.findUserById).not.toHaveBeenCalled();
  });

  it('rotates a valid persisted refresh token and prevents reuse', async () => {
    mocks.consumeRefreshToken
      .mockResolvedValueOnce({
        id: 'refresh-id',
        user: registeredUser.id,
        token: 'old-refresh',
        expiresAt: new Date(Date.now() + 60_000),
        createdAt,
      })
      .mockResolvedValueOnce(null);
    mocks.findUserById.mockResolvedValue(registeredUser);

    const response = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'old-refresh' })
      .expect(200);
    expect(response.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    expect(response.body.refreshToken).not.toBe('old-refresh');
    expect(mocks.createRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ user: registeredUser.id, token: response.body.refreshToken }),
    );

    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'old-refresh' })
      .expect(401, { error: 'invalid_refresh' });
  });

  it('rejects invalid and expired refresh tokens', async () => {
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'missing-token' })
      .expect(401, { error: 'invalid_refresh' });

    mocks.consumeRefreshToken.mockResolvedValue({
      id: 'expired-id',
      user: registeredUser.id,
      token: 'expired-token',
      expiresAt: new Date(Date.now() - 1_000),
      createdAt,
    });
    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'expired-token' })
      .expect(401, { error: 'refresh_expired' });
    expect(mocks.createRefreshToken).not.toHaveBeenCalled();
  });

  it('logs out idempotently and makes the deleted refresh token unusable', async () => {
    mocks.deleteRefreshToken.mockResolvedValue(true);
    await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: 'refresh-to-revoke' })
      .expect(200, { success: true });
    expect(mocks.deleteRefreshToken).toHaveBeenCalledWith('refresh-to-revoke');

    await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'refresh-to-revoke' })
      .expect(401, { error: 'invalid_refresh' });
  });

  it('supports participant password and Tedix-linked login', async () => {
    const participant = { ...registeredUser, role: 'participant' as const, roles: ['participant'] };
    const passwordHash = await bcrypt.hash('participant-password', 4);
    mocks.findUser
      .mockResolvedValueOnce({ ...participant, passwordHash })
      .mockResolvedValueOnce({ ...participant, tedixUserId: 'tedix-123' });

    await request(app)
      .post('/api/auth/participant/login')
      .send({ email: participant.email, password: 'participant-password' })
      .expect(200);
    await request(app)
      .post('/api/auth/participant/login')
      .send({ tedixUserId: 'tedix-123' })
      .expect(200);
    expect(mocks.createRefreshToken).toHaveBeenCalledTimes(2);
  });

  it('preserves the guest distinction', async () => {
    mocks.createUser.mockResolvedValue({
      ...registeredUser,
      email: null,
      passwordHash: null,
      role: 'participant',
      roles: ['participant'],
      isGuest: true,
    });

    const response = await request(app).post('/api/auth/guest').expect(201);

    expect(mocks.createUser).toHaveBeenCalledWith({ role: 'participant', isGuest: true });
    expect(response.body.user).toMatchObject({
      role: 'participant',
      roles: ['participant'],
      isGuest: true,
    });
    expect(response.body.tokens).not.toHaveProperty('refreshToken');
  });
});
