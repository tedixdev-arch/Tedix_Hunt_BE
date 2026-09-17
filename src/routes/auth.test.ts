import request from 'supertest';
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  findUser: vi.fn(),
  findUserById: vi.fn(),
  createRefreshToken: vi.fn(),
  organizationsForUser: vi.fn(),
}));

vi.mock('../models/User.js', () => ({
  User: {
    create: mocks.createUser,
    findOne: mocks.findUser,
    findById: mocks.findUserById,
  },
}));
vi.mock('../models/RefreshToken.js', () => ({
  RefreshToken: { create: mocks.createRefreshToken, findOne: vi.fn(), deleteOne: vi.fn() },
}));
vi.mock('../models/Organization.js', () => ({
  Organization: { findByOwnerOrMember: mocks.organizationsForUser },
}));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const createdAt = new Date('2026-01-02T03:04:05Z');
const registeredUser = {
  id: '7dc65d7e-cd31-4205-b92d-c716a7ae494a',
  email: 'person@example.com',
  passwordHash: '$2a$10$database-hash',
  role: 'creator',
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
    mocks.organizationsForUser.mockResolvedValue([]);
  });

  it('hashes a registered user password and never returns its hash', async () => {
    const response = await request(app)
      .post('/api/auth/creator/register')
      .send({ email: 'person@example.com', password: 'plain-secret', name: 'Person' })
      .expect(201);

    const createInput = mocks.createUser.mock.calls[0][0];
    expect(createInput.passwordHash).not.toBe('plain-secret');
    await expect(bcrypt.compare('plain-secret', createInput.passwordHash)).resolves.toBe(true);
    expect(response.body.user).toMatchObject({ isGuest: false, role: 'creator' });
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects an existing email cleanly', async () => {
    mocks.findUser.mockResolvedValue(registeredUser);

    await request(app)
      .post('/api/auth/creator/register')
      .send({ email: 'person@example.com', password: 'plain-secret' })
      .expect(409, { error: 'email_taken' });
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it('maps a database uniqueness race to the same safe response', async () => {
    mocks.createUser.mockRejectedValue(Object.assign(new Error('private database detail'), { code: '23505' }));

    const response = await request(app)
      .post('/api/auth/creator/register')
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
      .post('/api/auth/creator/register')
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
    const token = signJwt({ sub: registeredUser.id });

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({ id: registeredUser.id, isGuest: false });
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('refreshToken');
  });

  it('preserves the guest distinction', async () => {
    mocks.createUser.mockResolvedValue({
      ...registeredUser,
      email: null,
      passwordHash: null,
      role: 'participant',
      isGuest: true,
    });

    const response = await request(app).post('/api/auth/guest').expect(201);

    expect(mocks.createUser).toHaveBeenCalledWith({ role: 'participant', isGuest: true });
    expect(response.body.user).toMatchObject({ role: 'participant', isGuest: true });
    expect(response.body.tokens).not.toHaveProperty('refreshToken');
  });
});
