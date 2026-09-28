import request from 'supertest';
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), list: vi.fn(), approve: vi.fn(), reject: vi.fn(), findUserById: vi.fn(),
}));
vi.mock('../models/OrganizerApplication.js', () => ({
  ApplicationNotPendingError: class ApplicationNotPendingError extends Error {},
  OrganizerApplications: {
    create: mocks.create, list: mocks.list, approve: mocks.approve, reject: mocks.reject,
  },
}));
vi.mock('../models/User.js', () => ({
  User: { findById: mocks.findUserById },
}));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const app = createApp();
const validInput = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  organizationName: 'Analytical Academy',
  organizationType: 'school',
  reason: 'Run educational Hunts',
  phone: '+44 1234',
  password: 'Secure123!',
  confirmPassword: 'Secure123!',
};
const created = {
  id: 'application-1',
  name: validInput.name, email: validInput.email, organizationName: validInput.organizationName,
  organizationType: validInput.organizationType, reason: validInput.reason, phone: validInput.phone,
  status: 'pending',
  createdAt: new Date('2026-09-18T12:00:00.000Z'),
  updatedAt: new Date('2026-09-18T12:00:00.000Z'),
};
const reviewedFields = {
  reviewedAt: null, reviewedBy: null, userId: null, organizationId: null,
};
const admin = {
  id: 'admin-1', email: 'admin@example.com', role: 'participant', roles: ['admin'],
  isGuest: false, createdAt: new Date(),
};
const bearer = `Bearer ${signJwt({ sub: admin.id, type: 'access' })}`;

describe('POST /api/organizer-applications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue(created);
  });

  it('publicly creates a pending application and returns only public fields', async () => {
    const response = await request(app).post('/api/organizer-applications')
      .send(validInput).expect(201);

    expect(response.body).toEqual({
      id: created.id,
      name: validInput.name, email: validInput.email, organizationName: validInput.organizationName,
      organizationType: validInput.organizationType, reason: validInput.reason, phone: validInput.phone,
      status: 'pending',
      createdAt: created.createdAt.toISOString(),
    });
    expect(response.body).not.toHaveProperty('updatedAt');
    expect(response.body).not.toHaveProperty('password');
    expect(mocks.create).toHaveBeenCalledOnce();
    const stored = mocks.create.mock.calls[0][0];
    expect(stored.passwordHash).not.toBe(validInput.password);
    await expect(bcrypt.compare(validInput.password, stored.passwordHash)).resolves.toBe(true);
  });

  it('normalizes email and trims surrounding whitespace', async () => {
    await request(app).post('/api/organizer-applications').send({
      ...validInput,
      name: '  Ada Lovelace  ',
      email: '  ADA@EXAMPLE.COM  ',
      organizationName: '  Analytical Academy  ',
      reason: '  Run educational Hunts  ',
      phone: '  +44 1234  ',
    }).expect(201);

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      name: validInput.name, email: validInput.email, organizationName: validInput.organizationName,
      reason: validInput.reason, phone: validInput.phone, passwordHash: expect.any(String),
    }));
  });

  it.each([undefined, '', '   ', null])('turns optional phone %p into null', async (phone) => {
    const input: Record<string, unknown> = { ...validInput, phone };
    if (phone === undefined) delete input.phone;
    await request(app).post('/api/organizer-applications').send(input).expect(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ phone: null }));
  });

  it.each([
    ['name', undefined],
    ['email', undefined],
    ['organizationName', undefined],
    ['reason', undefined],
    ['name', '   '],
  ])('rejects invalid required field %s', async (field, value) => {
    const input: Record<string, unknown> = { ...validInput, [field]: value };
    if (value === undefined) delete input[field];
    await request(app).post('/api/organizer-applications').send(input)
      .expect(400, { error: 'invalid_input' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid organization type', async () => {
    await request(app).post('/api/organizer-applications')
      .send({ ...validInput, organizationType: 'company' })
      .expect(400, { error: 'invalid_input' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ confirmPassword: undefined }, { error: 'invalid_input' }],
    [{ password: undefined }, { error: 'invalid_input' }],
    [{ password: 'short', confirmPassword: 'short' }, {
      error: 'password_policy_not_met',
      message: 'Password must be at least 8 characters and include a letter, a number, and a special character.',
    }],
    [{ confirmPassword: 'different-password' }, { error: 'password_confirmation_mismatch' }],
  ])('rejects invalid credentials %#', async (overrides, body) => {
    const input: Record<string, unknown> = { ...validInput, ...overrides };
    for (const [key, value] of Object.entries(input)) if (value === undefined) delete input[key];
    await request(app).post('/api/organizer-applications').send(input).expect(400, body);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects a weak application password through the shared policy', async () => {
    await request(app).post('/api/organizer-applications').send({
      ...validInput, password: 'password1', confirmPassword: 'password1',
    }).expect(400, { error: 'password_policy_not_met', message: 'Password must be at least 8 characters and include a letter, a number, and a special character.' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects client-supplied status so an applicant cannot approve itself', async () => {
    await request(app).post('/api/organizer-applications')
      .send({ ...validInput, status: 'approved' })
      .expect(400, { error: 'invalid_input' });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('admin organizer application decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(admin);
    mocks.list.mockResolvedValue([{ ...created, ...reviewedFields }]);
  });

  it.each([
    ['get', '/api/organizer-applications'],
    ['post', '/api/organizer-applications/application-1/approve'],
    ['post', '/api/organizer-applications/application-1/reject'],
  ] as const)('requires authentication for %s %s', async (method, path) => {
    await request(app)[method](path).expect(401, { error: 'unauthorized' });
  });

  it('rejects every admin operation when authoritative roles omit admin', async () => {
    mocks.findUserById.mockResolvedValue({ ...admin, role: 'admin', roles: ['organizer'] });
    await request(app).get('/api/organizer-applications').set('Authorization', bearer).expect(403);
    await request(app).post('/api/organizer-applications/application-1/approve').set('Authorization', bearer).expect(403);
    await request(app).post('/api/organizer-applications/application-1/reject').set('Authorization', bearer).expect(403);
  });

  it('lists applications by optional status without exposing a token hash', async () => {
    const response = await request(app).get('/api/organizer-applications?status=pending')
      .set('Authorization', bearer).expect(200);
    expect(mocks.list).toHaveBeenCalledWith('pending');
    expect(response.body[0]).not.toHaveProperty('activationTokenHash');
  });

  it('approves without returning an activation credential', async () => {
    const approved = {
      ...created, ...reviewedFields, status: 'approved', reviewedBy: admin.id,
      userId: 'user-1', organizationId: 'org-1',
    };
    mocks.approve.mockResolvedValue(approved);
    const response = await request(app).post('/api/organizer-applications/application-1/approve')
      .set('Authorization', bearer).expect(200);
    expect(mocks.approve).toHaveBeenCalledWith('application-1', admin.id);
    expect(response.body).not.toHaveProperty('activationToken');
    expect(response.body).not.toHaveProperty('activationExpiresAt');
    expect(response.body.application).not.toHaveProperty('activationTokenHash');
  });

  it('rejects a pending application as the authenticated admin', async () => {
    mocks.reject.mockResolvedValue({
      ...created, ...reviewedFields, status: 'rejected', reviewedBy: admin.id,
    });
    const response = await request(app).post('/api/organizer-applications/application-1/reject')
      .set('Authorization', bearer).expect(200);
    expect(response.body.application.status).toBe('rejected');
    expect(mocks.reject).toHaveBeenCalledWith('application-1', admin.id);
  });
});
