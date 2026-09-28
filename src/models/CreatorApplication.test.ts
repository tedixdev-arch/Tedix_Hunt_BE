import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), clientQuery: vi.fn(), release: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({ pool: { query: mocks.query, connect: mocks.connect } }));

import {
  CreatorApplications, CreatorApplicationIdentityConflictError,
} from './CreatorApplication.js';

const input = { name: 'Ada', email: 'ADA@example.com', passwordHash: '$2a$10$application-hash' };
const row = {
  id: 'application-1', user_id: 'user-1', name: 'Ada', email: 'ada@example.com', status: 'pending',
  created_at: new Date(), updated_at: new Date(), reviewed_at: null, reviewed_by: null,
};

describe('CreatorApplications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  });

  it('creates one identity and a pending application without granting a role or creating a token', async () => {
    mocks.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', password_hash: input.passwordHash }] })
      .mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({});
    await expect(CreatorApplications.create(input)).resolves.toMatchObject({ status: 'pending' });
    const sql = mocks.clientQuery.mock.calls.map(([value]) => String(value)).join('\n');
    expect(sql).toContain('INSERT INTO users');
    expect(sql).toContain('INSERT INTO creator_applications');
    expect(sql).not.toContain('INSERT INTO user_roles');
    expect(sql).not.toContain('professional_activation_tokens');
    expect(mocks.clientQuery.mock.calls[4][1]).not.toContain(input.passwordHash);
  });

  it('never overwrites the password of a reused normalized identity', async () => {
    mocks.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        id: 'user-1', password_hash: 'existing-hash', is_guest: false,
        account_status: 'active', is_creator: false,
      }] }).mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({});
    await CreatorApplications.create(input);
    const sql = mocks.clientQuery.mock.calls.map(([value]) => String(value)).join('\n');
    expect(sql).not.toContain('INSERT INTO users');
    expect(sql).not.toContain('UPDATE users SET password_hash');
    expect(mocks.clientQuery.mock.calls[2][1]).toEqual(['ada@example.com']);
  });

  it.each(['blocked', 'retired'])('rejects a %s identity without changing it', async (accountStatus) => {
    mocks.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        id: 'user-1', password_hash: 'existing-hash', is_guest: false,
        account_status: accountStatus, is_creator: false,
      }] }).mockResolvedValueOnce({});
    await expect(CreatorApplications.create(input)).rejects
      .toBeInstanceOf(CreatorApplicationIdentityConflictError);
    expect(mocks.clientQuery.mock.calls.map(([value]) => String(value)).join('\n'))
      .not.toMatch(/INSERT INTO users|UPDATE users SET password_hash/);
  });

  it('approves atomically with only Creator capability and no credential/token changes', async () => {
    mocks.clientQuery.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ account_status: 'active', is_guest: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...row, status: 'approved', reviewed_by: 'admin-1' }] })
      .mockResolvedValueOnce({});
    await CreatorApplications.approve('application-1', 'admin-1');
    const sql = mocks.clientQuery.mock.calls.map(([value]) => String(value)).join('\n');
    expect(sql).toContain("INSERT INTO user_roles (user_id, role) VALUES ($1, 'creator')");
    expect(sql).not.toMatch(/professional_activation_tokens|password_hash\s*=/i);
    expect(sql).not.toMatch(/'organizer'|'admin'|'participant'|'supervisor'/);
  });

  it('rejects while preserving identity and granting no capability', async () => {
    mocks.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ ...row, status: 'rejected' }] }).mockResolvedValueOnce({});
    await CreatorApplications.reject('application-1', 'admin-1');
    const sql = mocks.clientQuery.mock.calls.map(([value]) => String(value)).join('\n');
    expect(sql).not.toMatch(/DELETE FROM users|INSERT INTO user_roles|professional_activation_tokens/);
  });
});
