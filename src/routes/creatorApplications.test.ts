import request from 'supertest';
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), approve: vi.fn(), reject: vi.fn(), findUserById: vi.fn(),
}));
vi.mock('../models/CreatorApplication.js', () => ({
  CreatorApplicationIdentityConflictError: class CreatorApplicationIdentityConflictError extends Error {},
  CreatorApplicationNotPendingError: class CreatorApplicationNotPendingError extends Error {},
  CreatorApplications: {
    create: mocks.create, list: mocks.list, approve: mocks.approve, reject: mocks.reject,
  },
}));
vi.mock('../models/User.js', () => ({ User: { findById: mocks.findUserById } }));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const app = createApp();
const input = {
  name: 'Ada Creator', email: 'ada@example.com', password: 'Secure123!', confirmPassword: 'Secure123!',
};
const pending = {
  id: 'application-1', userId: 'user-1', name: input.name, email: input.email,
  status: 'pending', createdAt: new Date('2026-09-28T12:00:00Z'),
  updatedAt: new Date('2026-09-28T12:00:00Z'), reviewedAt: null, reviewedBy: null,
};
const admin = {
  id: 'admin-1', email: 'admin@example.com', role: 'participant', roles: ['admin'],
  isGuest: false, accountStatus: 'active', createdAt: new Date(),
};
const bearer = `Bearer ${signJwt({ sub: admin.id, type: 'access' })}`;

describe('Creator application routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue(pending);
    mocks.list.mockResolvedValue([pending]);
    mocks.findUserById.mockResolvedValue(admin);
  });

  it('creates a pending application with a bcrypt hash and no credential in the response', async () => {
    const response = await request(app).post('/api/creator-applications').send(input).expect(201);
    expect(response.body).toEqual({
      id: pending.id, name: input.name, email: input.email, status: 'pending',
      createdAt: pending.createdAt.toISOString(),
    });
    const stored = mocks.create.mock.calls[0][0];
    expect(stored).not.toHaveProperty('password');
    await expect(bcrypt.compare(input.password, stored.passwordHash)).resolves.toBe(true);
  });

  it.each([
    [{ password: 'password1', confirmPassword: 'password1' }, 'password_policy_not_met'],
    [{ confirmPassword: 'Different1!' }, 'password_confirmation_mismatch'],
  ])('rejects invalid passwords %#', async (override, error) => {
    await request(app).post('/api/creator-applications').send({ ...input, ...override })
      .expect(400).expect(({ body }) => expect(body.error).toBe(error));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects applicant-controlled workflow fields', async () => {
    await request(app).post('/api/creator-applications').send({ ...input, status: 'approved' })
      .expect(400, { error: 'invalid_input' });
  });

  it.each([
    ['get', '/api/creator-applications'],
    ['post', '/api/creator-applications/application-1/approve'],
    ['post', '/api/creator-applications/application-1/reject'],
  ] as const)('requires Admin authentication for %s %s', async (method, path) => {
    await request(app)[method](path).expect(401);
  });

  it('uses authoritative Admin roles and lists pending applications', async () => {
    const response = await request(app).get('/api/creator-applications?status=pending')
      .set('Authorization', bearer).expect(200);
    expect(mocks.list).toHaveBeenCalledWith('pending');
    expect(response.body[0]).toMatchObject({ status: 'pending', userId: 'user-1' });
    mocks.findUserById.mockResolvedValue({ ...admin, role: 'admin', roles: ['creator'] });
    await request(app).get('/api/creator-applications').set('Authorization', bearer).expect(403);
  });

  it('approves without returning any activation credential', async () => {
    mocks.approve.mockResolvedValue({ ...pending, status: 'approved', reviewedBy: admin.id });
    const response = await request(app).post('/api/creator-applications/application-1/approve')
      .set('Authorization', bearer).expect(200);
    expect(mocks.approve).toHaveBeenCalledWith('application-1', admin.id);
    expect(JSON.stringify(response.body)).not.toMatch(/activation|password/i);
  });

  it('rejects without returning any activation credential', async () => {
    mocks.reject.mockResolvedValue({ ...pending, status: 'rejected', reviewedBy: admin.id });
    const response = await request(app).post('/api/creator-applications/application-1/reject')
      .set('Authorization', bearer).expect(200);
    expect(response.body.application.status).toBe('rejected');
    expect(JSON.stringify(response.body)).not.toMatch(/activation|password/i);
  });
});
