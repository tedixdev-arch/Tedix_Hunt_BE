import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, connect, clientQuery, release } = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../lib/postgres.js', () => ({ pool: { query, connect } }));

import { LastActiveAdminError, User, USER_ROLES } from './User.js';

const storedRow = {
  id: '7dc65d7e-cd31-4205-b92d-c716a7ae494a',
  email: 'person@example.com',
  password_hash: '$2a$10$stored-hash',
  role: 'participant',
  roles: ['participant'],
  name: 'Person',
  is_guest: false,
  tedix_user_id: null,
  account_status: 'active',
  created_at: new Date('2026-01-02T03:04:05Z'),
};

describe('User persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({ query: clientQuery, release });
    clientQuery.mockResolvedValue({ rows: [] });
  });

  it('creates a registered user with a normalized email and password hash', async () => {
    query.mockResolvedValue({ rows: [storedRow] });

    const user = await User.create({
      email: '  Person@Example.COM ',
      passwordHash: '$2a$10$stored-hash',
      role: 'participant',
      name: 'Person',
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), [
      'person@example.com',
      '$2a$10$stored-hash',
      'participant',
      'Person',
      false,
      null,
    ]);
    expect(user).toMatchObject({ email: 'person@example.com', isGuest: false });
  });

  it('retrieves an existing user using the same email normalization', async () => {
    query.mockResolvedValue({ rows: [storedRow] });

    await expect(User.findOne({ email: 'PERSON@example.com' })).resolves.toMatchObject({
      id: storedRow.id,
      passwordHash: storedRow.password_hash,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('email = $1'), [
      'person@example.com',
    ]);
  });

  it('preserves guest and Tedix-linked account fields', async () => {
    query.mockResolvedValue({
      rows: [{ ...storedRow, email: null, password_hash: null, is_guest: true, tedix_user_id: 'tedix-7' }],
    });

    await expect(
      User.create({ role: 'participant', isGuest: true, tedixUserId: 'tedix-7' }),
    ).resolves.toMatchObject({ isGuest: true, tedixUserId: 'tedix-7' });
  });

  it('documents supported roles and rejects unsupported roles before querying', async () => {
    expect(USER_ROLES).toEqual(['participant', 'organizer', 'creator', 'admin']);

    await expect(User.create({ role: 'administrator' as never })).rejects.toThrow(
      'invalid_user_role',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('atomically changes the password and removes only that user\'s refresh sessions', async () => {
    await User.changePasswordAndRevokeSessions(storedRow.id, 'new-bcrypt-hash');

    expect(clientQuery.mock.calls).toEqual([
      ['BEGIN'],
      ['UPDATE users SET password_hash = $1 WHERE id = $2', ['new-bcrypt-hash', storedRow.id]],
      ['DELETE FROM refresh_tokens WHERE user_id = $1', [storedRow.id]],
      ['COMMIT'],
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('atomically updates only normalized identity fields and returns preserved state', async () => {
    query.mockResolvedValue({ rows: [{
      ...storedRow, email: 'new@example.com', name: 'New Name', account_status: 'blocked',
      roles: ['admin', 'participant'],
    }] });
    await expect(User.updateIdentity(storedRow.id, {
      name: 'New Name', email: ' NEW@EXAMPLE.COM ',
    })).resolves.toMatchObject({
      email: 'new@example.com', name: 'New Name', passwordHash: storedRow.password_hash,
      accountStatus: 'blocked', roles: ['admin', 'participant'],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), [
      storedRow.id, true, 'New Name', true, 'new@example.com',
    ]);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/password_hash\s*=|account_status\s*=|DELETE/i);
    expect(sql).not.toContain('refresh_tokens');
  });

  it.each([
    ['password update', 1],
    ['refresh-token deletion', 2],
  ])('rolls back if the %s fails', async (_label, failingCall) => {
    clientQuery.mockImplementation(async () => {
      if (clientQuery.mock.calls.length === failingCall + 1) throw new Error('database failure');
      return { rows: [] };
    });

    await expect(
      User.changePasswordAndRevokeSessions(storedRow.id, 'new-bcrypt-hash'),
    ).rejects.toThrow('database failure');
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('blocks atomically, protects roles and business data, and revokes refresh sessions', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [storedRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...storedRow, account_status: 'blocked' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(User.setAccountStatus(storedRow.id, 'blocked')).resolves.toMatchObject({
      accountStatus: 'blocked', roles: ['participant'],
    });
    expect(clientQuery).toHaveBeenCalledWith(
      'DELETE FROM refresh_tokens WHERE user_id = $1', [storedRow.id],
    );
    expect(clientQuery).not.toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM (user_roles|organizations|hunts)/), expect.anything());
    expect(clientQuery).toHaveBeenCalledWith(
      'UPDATE users SET account_status = $2 WHERE id = $1', [storedRow.id, 'blocked'],
    );
  });

  it('unblocks without recreating previously revoked sessions', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...storedRow, account_status: 'blocked' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...storedRow, account_status: 'active' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(User.setAccountStatus(storedRow.id, 'active')).resolves.toMatchObject({
      accountStatus: 'active',
    });
    expect(clientQuery).not.toHaveBeenCalledWith(expect.stringContaining('refresh_tokens'), expect.anything());
  });

  it('rejects blocking the final active authoritative Admin under the invariant lock', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...storedRow, account_status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(User.setAccountStatus(storedRow.id, 'blocked'))
      .rejects.toBeInstanceOf(LastActiveAdminError);
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith(
      'UPDATE users SET account_status = $2 WHERE id = $1', expect.anything(),
    );
  });
});
