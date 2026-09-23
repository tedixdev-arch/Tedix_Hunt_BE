import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findUserById: vi.fn(), findContexts: vi.fn() }));
vi.mock('../models/User.js', () => ({ User: { findById: mocks.findUserById } }));
vi.mock('../models/HuntContext.js', () => ({ HuntContext: { findForUser: mocks.findContexts } }));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const user = {
  id: 'user-1', email: 'user@example.com', passwordHash: null, role: 'participant' as const,
  roles: ['participant'], name: 'User', isGuest: false, tedixUserId: null, createdAt: new Date(),
};
const auth = `Bearer ${signJwt({ sub: user.id, type: 'access' })}`;
const app = createApp();

describe('GET /api/me/hunt-contexts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user);
    mocks.findContexts.mockResolvedValue([]);
  });

  it('requires authentication', async () => {
    await request(app).get('/api/me/hunt-contexts').expect(401, { error: 'unauthorized' });
    expect(mocks.findContexts).not.toHaveBeenCalled();
  });

  it.each([
    ['participant only', true, false],
    ['supervisor only', false, true],
    ['participant and supervisor', true, true],
  ])('returns exactly one %s context with both access flags', async (_case, participant, supervisor) => {
    mocks.findContexts.mockResolvedValueOnce([{
      huntId: 'hunt-1', huntName: 'City Hunt', huntStatus: 'active', participant, supervisor,
    }]);
    const response = await request(app).get('/api/me/hunt-contexts')
      .set('Authorization', auth).expect(200);
    expect(response.body).toEqual({ contexts: [{
      huntId: 'hunt-1', huntName: 'City Hunt', huntStatus: 'active', participant, supervisor,
    }] });
    expect(mocks.findContexts).toHaveBeenCalledWith(user.id);
  });

  it('preserves model ordering across multiple Hunts', async () => {
    const contexts = [
      { huntId: 'active', huntName: 'Active', huntStatus: 'active', participant: true, supervisor: false },
      { huntId: 'paused-new', huntName: 'Paused New', huntStatus: 'paused', participant: false, supervisor: true },
      { huntId: 'paused-old', huntName: 'Paused Old', huntStatus: 'paused', participant: true, supervisor: true },
      { huntId: 'finished', huntName: 'Finished', huntStatus: 'finished', participant: true, supervisor: false },
    ];
    mocks.findContexts.mockResolvedValueOnce(contexts);
    const response = await request(app).get('/api/me/hunt-contexts')
      .set('Authorization', auth).expect(200);
    expect(response.body.contexts).toEqual(contexts);
  });

  it.each([
    ['an unrelated user', []],
    ['a global organizer only', ['organizer']],
    ['a global participant without enrollment', ['participant']],
  ])('returns no context for %s', async (_case, roles) => {
    mocks.findUserById.mockResolvedValueOnce({ ...user, roles });
    await request(app).get('/api/me/hunt-contexts').set('Authorization', auth)
      .expect(200, { contexts: [] });
    expect(mocks.findContexts).toHaveBeenCalledWith(user.id);
  });
});
