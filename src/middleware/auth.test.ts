import express from 'express';
import request from 'supertest';
import { beforeEach, describe, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findById: vi.fn() }));

vi.mock('../models/User.js', () => ({
  User: { findById: mocks.findById },
}));

import { signJwt } from '../lib/jwt.js';
import { requireAnyRole, requireAuth, requireRole } from './auth.js';

const user = (roles: string[], overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'person@example.com',
  passwordHash: null,
  role: 'participant',
  roles,
  name: 'Person',
  isGuest: false,
  tedixUserId: null,
  createdAt: new Date('2026-01-02T03:04:05Z'),
  ...overrides,
});

const token = signJwt({ sub: 'user-1', type: 'access' });

describe('capability authorization', () => {
  const app = express();
  app.get('/creator', requireAuth, requireRole('creator'), (_req, res) => res.json({ ok: true }));
  app.get('/participant', requireAuth, requireRole('participant'), (_req, res) => res.json({ ok: true }));
  app.get('/operations', requireAuth, requireAnyRole(['organizer', 'admin']), (_req, res) =>
    res.json({ ok: true }),
  );

  beforeEach(() => vi.clearAllMocks());

  it('distinguishes missing authentication from a missing capability', async () => {
    await request(app).get('/creator').expect(401, { error: 'unauthorized' });

    mocks.findById.mockResolvedValue(user(['participant']));
    await request(app)
      .get('/creator')
      .set('Authorization', `Bearer ${token}`)
      .expect(403, { error: 'forbidden' });
  });

  it('allows a multi-role user based on canonical roles rather than the legacy role', async () => {
    mocks.findById.mockResolvedValue(user(['participant', 'creator']));
    await request(app)
      .get('/creator')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { ok: true });

    mocks.findById.mockResolvedValue(user(['participant'], { role: 'creator' }));
    await request(app)
      .get('/creator')
      .set('Authorization', `Bearer ${token}`)
      .expect(403, { error: 'forbidden' });
  });

  it('does not treat creator as participant and checks organizer/admin roles independently', async () => {
    mocks.findById.mockResolvedValue(user(['creator'], { role: 'creator' }));
    await request(app)
      .get('/participant')
      .set('Authorization', `Bearer ${token}`)
      .expect(403, { error: 'forbidden' });

    for (const role of ['organizer', 'admin']) {
      mocks.findById.mockResolvedValue(user([role]));
      await request(app)
        .get('/operations')
        .set('Authorization', `Bearer ${token}`)
        .expect(200, { ok: true });
    }
  });

  it('keeps guests participant-capable without granting privileged capabilities', async () => {
    mocks.findById.mockResolvedValue(user(['participant'], { isGuest: true }));
    await request(app)
      .get('/participant')
      .set('Authorization', `Bearer ${token}`)
      .expect(200, { ok: true });
    await request(app)
      .get('/creator')
      .set('Authorization', `Bearer ${token}`)
      .expect(403, { error: 'forbidden' });

    mocks.findById.mockResolvedValue(user(['participant', 'admin'], { isGuest: true }));
    await request(app)
      .get('/operations')
      .set('Authorization', `Bearer ${token}`)
      .expect(403, { error: 'forbidden' });
  });
});
