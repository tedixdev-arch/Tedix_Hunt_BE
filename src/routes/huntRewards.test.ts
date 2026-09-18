import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rewardOptions } from '../domain/rewards.js';

const mocks = vi.hoisted(() => ({
  findUserById: vi.fn(), findHuntById: vi.fn(), hasRole: vi.fn(),
  list: vi.fn(), findLeaderboard: vi.fn(), findSpecial: vi.fn(),
  createLeaderboard: vi.fn(), updateLeaderboard: vi.fn(), deleteLeaderboard: vi.fn(),
  createSpecial: vi.fn(), updateSpecial: vi.fn(), deleteSpecial: vi.fn(),
}));

vi.mock('../models/User.js', () => ({ User: { findById: mocks.findUserById } }));
vi.mock('../models/Hunt.js', () => ({ Hunt: { findById: mocks.findHuntById } }));
vi.mock('../models/HuntRole.js', () => ({ HuntRoles: { hasRole: mocks.hasRole } }));
vi.mock('../models/HuntReward.js', () => ({ HuntReward: {
  list: mocks.list, findLeaderboard: mocks.findLeaderboard, findSpecial: mocks.findSpecial,
  createLeaderboard: mocks.createLeaderboard, updateLeaderboard: mocks.updateLeaderboard,
  deleteLeaderboard: mocks.deleteLeaderboard, createSpecial: mocks.createSpecial,
  updateSpecial: mocks.updateSpecial, deleteSpecial: mocks.deleteSpecial,
} }));

import { createApp } from '../app.js';
import { signJwt } from '../lib/jwt.js';

const user = { id: 'user-1', roles: ['creator'], role: 'creator' };
const hunt = { id: 'hunt-1', status: 'draft' };
const organizerPhysical = {
  provider: 'organizer', kind: 'physical', category: null,
  name: 'Book voucher', description: 'Local bookstore', quantity: 4,
};
const leaderboard = { id: 'reward-1', huntId: hunt.id, place: 1, ...organizerPhysical };
const special = {
  id: 'special-1', huntId: hunt.id, definitionKey: 'team-precision',
  provider: 'tedix_inventory', kind: 'virtual', category: 'profile_badge',
  name: null, description: null, quantity: 4,
};
const auth = `Bearer ${signJwt({ sub: user.id, type: 'access' })}`;
const app = createApp();

describe('reward metadata and Hunt reward routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUserById.mockResolvedValue(user);
    mocks.findHuntById.mockResolvedValue(hunt);
    mocks.hasRole.mockImplementation((_h, _u, role) => role === 'organizer');
    mocks.list.mockResolvedValue({ leaderboard: [leaderboard], specialAwards: [special] });
    mocks.findLeaderboard.mockResolvedValue(leaderboard);
    mocks.findSpecial.mockResolvedValue(special);
    mocks.createLeaderboard.mockResolvedValue(leaderboard);
    mocks.updateLeaderboard.mockResolvedValue({ ...leaderboard, quantity: 2 });
    mocks.deleteLeaderboard.mockResolvedValue(true);
    mocks.createSpecial.mockResolvedValue(special);
    mocks.updateSpecial.mockResolvedValue({ ...special, quantity: 2 });
    mocks.deleteSpecial.mockResolvedValue(true);
  });

  it('requires authentication for exact backend-controlled metadata without stock data', async () => {
    await request(app).get('/api/reward-options').expect(401, { error: 'unauthorized' });
    const response = await request(app).get('/api/reward-options').set('Authorization', auth).expect(200);
    expect(response.body).toEqual(rewardOptions);
    expect(response.body.virtualCategories.map(({ key }: { key: string }) => key)).toEqual([
      'achievement', 'digital_certificate', 'profile_badge',
      'hunt_passport_collectible', 'partner_digital_benefit',
    ]);
    expect(response.body.specialAwardDefinitions).toEqual([
      {
        key: 'team-precision', scope: 'team', name: 'Team Precision',
        rule: 'Highest correct team answers ÷ submitted team answers.',
        description: 'Recognizes accurate collective decisions across the Hunt.',
        eligibility: 'Complete at least 70% of team challenges.',
      },
      {
        key: 'everyone-contributed', scope: 'team', name: 'Everyone Contributed',
        rule: 'Highest percentage of team stages where every active member contributed.',
        description: 'Recognizes balanced participation, not one dominant player.',
        eligibility: 'At least three completed team stages.',
      },
      {
        key: 'strong-comeback', scope: 'team', name: 'Strong Comeback',
        rule: 'Most challenges solved after an incorrect attempt without revealing the solution.',
        description: 'Recognizes constructive recovery when the first approach fails.',
        eligibility: 'Complete the Hunt without abandoning a team stage.',
      },
      {
        key: 'consistent-team', scope: 'team', name: 'Consistent Team',
        rule: 'Highest percentage of checkpoints with no skipped personal or team contribution.',
        description: 'Recognizes reliable participation throughout the whole Hunt.',
        eligibility: 'Complete at least 70% of checkpoints.',
      },
      {
        key: 'personal-precision', scope: 'personal', name: 'Personal Precision',
        rule: 'Highest correct first attempts ÷ personal challenges attempted.',
        description: 'Recognizes careful and accurate individual problem solving.',
        eligibility: 'Complete at least 70% of assigned personal challenges.',
      },
      {
        key: 'persistent-solver', scope: 'personal', name: 'Persistent Solver',
        rule: 'Most personal challenges solved after a wrong attempt without revealing the solution.',
        description: 'Recognizes persistence and learning from an unsuccessful attempt.',
        eligibility: 'Complete at least three personal challenges.',
      },
      {
        key: 'smart-help', scope: 'personal', name: 'Smart Help Use',
        rule: 'Most challenges solved after a hint without revealing the solution.',
        description: 'Recognizes effective use of help while preserving ownership of the answer.',
        eligibility: 'At least one hint-assisted correct solution.',
      },
      {
        key: 'reliable-contributor', scope: 'personal', name: 'Reliable Contributor',
        rule: 'Highest percentage of assigned challenges completed and contributions submitted.',
        description: 'Recognizes dependable participation at every team stage.',
        eligibility: 'Complete at least 70% of assigned personal challenges.',
      },
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/stock|inventoryQuantity|available/i);
  });

  it('lets Hunt organizers and supervisors read only persisted reward records', async () => {
    await request(app).get('/api/hunts/hunt-1/rewards').set('Authorization', auth)
      .expect(200, { leaderboard: [leaderboard], specialAwards: [special] });
    mocks.hasRole.mockImplementation((_h, _u, role) => role === 'supervisor');
    const response = await request(app).get('/api/hunts/hunt-1/rewards').set('Authorization', auth).expect(200);
    expect(response.body.specialAwards[0]).not.toHaveProperty('rule');
    expect(response.body.specialAwards[0]).not.toHaveProperty('eligibility');
  });

  it('handles unknown Hunts, unrelated users, and unauthenticated reads', async () => {
    await request(app).get('/api/hunts/hunt-1/rewards').expect(401);
    mocks.findHuntById.mockResolvedValueOnce(null);
    await request(app).get('/api/hunts/missing/rewards').set('Authorization', auth).expect(404);
    mocks.hasRole.mockResolvedValue(false);
    await request(app).get('/api/hunts/hunt-1/rewards').set('Authorization', auth).expect(403);
  });

  it('creates, updates, and deletes leaderboard allocations for the organizer', async () => {
    await request(app).post('/api/hunts/hunt-1/rewards/leaderboard').set('Authorization', auth)
      .send({ place: 1, ...organizerPhysical }).expect(201, leaderboard);
    expect(mocks.createLeaderboard).toHaveBeenCalledWith(hunt.id, 1, organizerPhysical);

    await request(app).patch('/api/hunts/hunt-1/rewards/leaderboard/reward-1').set('Authorization', auth)
      .send({ quantity: 2 }).expect(200);
    expect(mocks.updateLeaderboard).toHaveBeenCalledWith(hunt.id, leaderboard.id, 1, {
      ...organizerPhysical, quantity: 2,
    });
    await request(app).delete('/api/hunts/hunt-1/rewards/leaderboard/reward-1')
      .set('Authorization', auth).expect(204);
  });

  it.each([0, 51, '1st place'])('rejects invalid leaderboard place %p', async (place) => {
    await request(app).post('/api/hunts/hunt-1/rewards/leaderboard').set('Authorization', auth)
      .send({ place, ...organizerPhysical }).expect(400, { error: 'invalid_input' });
  });

  it.each([
    { ...organizerPhysical, provider: 'sponsor' },
    { ...organizerPhysical, kind: 'cash' },
    { ...organizerPhysical, name: ' ' },
    { provider: 'tedix_inventory', kind: 'virtual', category: 'unknown', quantity: 1 },
  ])('rejects invalid reward details %#', async (details) => {
    await request(app).post('/api/hunts/hunt-1/rewards/leaderboard').set('Authorization', auth)
      .send({ place: 1, ...details }).expect(400, { error: 'invalid_input' });
  });

  it('clears client-supplied product identity for Tedix physical configuration', async () => {
    await request(app).post('/api/hunts/hunt-1/rewards/leaderboard').set('Authorization', auth).send({
      place: 1, provider: 'tedix_inventory', kind: 'physical', category: 'profile_badge',
      name: 'Hidden SKU', description: 'Hidden product', quantity: 1,
    }).expect(201);
    expect(mocks.createLeaderboard).toHaveBeenCalledWith(hunt.id, 1, {
      provider: 'tedix_inventory', kind: 'physical', category: null,
      name: null, description: null, quantity: 1,
    });
  });

  it('returns a stable conflict for a duplicate leaderboard place', async () => {
    mocks.createLeaderboard.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: '23505' }));
    await request(app).post('/api/hunts/hunt-1/rewards/leaderboard').set('Authorization', auth)
      .send({ place: 1, ...organizerPhysical }).expect(409, { error: 'reward_conflict' });
  });

  it('forbids supervisor writes and all writes on a non-draft Hunt', async () => {
    mocks.hasRole.mockImplementation((_h, _u, role) => role === 'supervisor');
    await request(app).post('/api/hunts/hunt-1/rewards/leaderboard').set('Authorization', auth)
      .send({ place: 1, ...organizerPhysical }).expect(403);
    mocks.hasRole.mockResolvedValue(true);
    mocks.findHuntById.mockResolvedValue({ ...hunt, status: 'published' });
    await request(app).post('/api/hunts/hunt-1/rewards/leaderboard').set('Authorization', auth)
      .send({ place: 1, ...organizerPhysical }).expect(409, { error: 'invalid_hunt_state' });
    await request(app).delete('/api/hunts/hunt-1/rewards/special/special-1').set('Authorization', auth)
      .expect(409, { error: 'invalid_hunt_state' });
  });

  it('creates, updates, and deletes a predefined Special Award', async () => {
    const input = {
      definitionKey: special.definitionKey, provider: special.provider, kind: special.kind,
      category: special.category, quantity: special.quantity,
    };
    await request(app).post('/api/hunts/hunt-1/rewards/special').set('Authorization', auth)
      .send(input).expect(201, special);
    await request(app).patch('/api/hunts/hunt-1/rewards/special/special-1').set('Authorization', auth)
      .send({ quantity: 2 }).expect(200);
    expect(mocks.updateSpecial).toHaveBeenCalledWith(hunt.id, special.id, special.definitionKey, {
      provider: special.provider, kind: special.kind, category: special.category,
      name: null, description: null, quantity: 2,
    });
    await request(app).delete('/api/hunts/hunt-1/rewards/special/special-1')
      .set('Authorization', auth).expect(204);
  });

  it('rejects unknown and duplicate Special Award definitions', async () => {
    await request(app).post('/api/hunts/hunt-1/rewards/special').set('Authorization', auth).send({
      definitionKey: 'organizer-formula', ...organizerPhysical,
    }).expect(400, { error: 'invalid_input' });
    mocks.createSpecial.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: '23505' }));
    await request(app).post('/api/hunts/hunt-1/rewards/special').set('Authorization', auth).send({
      definitionKey: 'team-precision', ...organizerPhysical,
    }).expect(409, { error: 'reward_conflict' });
  });
});
