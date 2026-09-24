import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, connect, clientQuery, release } = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../lib/postgres.js', () => ({ pool: { query, connect } }));

import {
  AdminPasswordChangeNotAllowedError, LastActiveAdminError, User, USER_ROLES,
  UserHasProtectedDependenciesError,
} from './User.js';

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

  it('atomically replaces a non-Admin credential and preserves all other state', async () => {
    const target = {
      ...storedRow, roles: ['creator', 'organizer', 'participant'], account_status: 'blocked',
    };
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [target] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(User.replaceNonAdminPasswordAndRevokeSessions(
      storedRow.id, '$2a$10$new-hash',
    )).resolves.toMatchObject({
      id: storedRow.id, roles: target.roles, accountStatus: 'blocked',
      email: storedRow.email, name: storedRow.name, passwordHash: '$2a$10$new-hash',
    });
    expect(clientQuery.mock.calls).toEqual([
      ['BEGIN'],
      [expect.stringContaining('FROM users WHERE id = $1 FOR UPDATE'), [storedRow.id]],
      ['UPDATE users SET password_hash = $1 WHERE id = $2', ['$2a$10$new-hash', storedRow.id]],
      ['DELETE FROM refresh_tokens WHERE user_id = $1', [storedRow.id]],
      ['COMMIT'],
    ]);
    const sql = clientQuery.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).not.toMatch(/UPDATE\s+(user_roles|organizations|hunts|hunt_roles|hunt_participants)/i);
    expect(sql).not.toMatch(/account_status\s*=/i);
  });

  it('rejects every authoritative Admin role combination before changing credentials', async () => {
    for (const roles of [['admin'], ['creator', 'admin'], ['organizer', 'admin']]) {
      vi.clearAllMocks();
      connect.mockResolvedValue({ query: clientQuery, release });
      clientQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ ...storedRow, roles }] })
        .mockResolvedValueOnce({ rows: [] });
      await expect(User.replaceNonAdminPasswordAndRevokeSessions(storedRow.id, 'hash'))
        .rejects.toBeInstanceOf(AdminPasswordChangeNotAllowedError);
      expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
      expect(clientQuery).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users SET password_hash'), expect.anything(),
      );
    }
  });

  it.each([2, 3])('rolls back the Admin replacement transaction when operation %s fails', async (call) => {
    clientQuery.mockImplementation(async () => {
      if (clientQuery.mock.calls.length === call + 1) throw new Error('database failure');
      if (clientQuery.mock.calls.length === 2) return { rows: [storedRow] };
      return { rows: [] };
    });
    await expect(User.replaceNonAdminPasswordAndRevokeSessions(storedRow.id, 'hash'))
      .rejects.toThrow('database failure');
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
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

  it.each(['active', 'blocked'])('transactionally deletes a dependency-free %s identity', async (status) => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...storedRow, account_status: status }] })
      .mockResolvedValueOnce({ rows: [{ present: false }] })
      .mockResolvedValue({ rows: [] });
    await expect(User.deleteControlled(storedRow.id)).resolves.toBe(true);
    expect(clientQuery.mock.calls.slice(-5)).toEqual([
      ['DELETE FROM refresh_tokens WHERE user_id = $1', [storedRow.id]],
      ['DELETE FROM professional_activation_tokens WHERE user_id = $1', [storedRow.id]],
      ['DELETE FROM user_roles WHERE user_id = $1', [storedRow.id]],
      ['DELETE FROM users WHERE id = $1', [storedRow.id]],
      ['COMMIT'],
    ]);
  });

  it('protects every existing business and history relationship before any deletion', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [storedRow] })
      .mockResolvedValueOnce({ rows: [{ present: true }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(User.deleteControlled(storedRow.id))
      .rejects.toBeInstanceOf(UserHasProtectedDependenciesError);
    const sql = clientQuery.mock.calls[3][0] as string;
    for (const relationship of [
      'organizations', 'organization_members', 'hunts', 'hunt_participants', 'hunt_roles',
      'organizer_applications', 'professional_activation_tokens',
    ]) expect(sql).toContain(relationship);
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith(expect.stringMatching(/^DELETE/), expect.anything());
  });

  it('uses the shared lock to reject deletion of the final active Admin', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...storedRow, roles: ['admin'] }] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(User.deleteControlled(storedRow.id)).rejects.toBeInstanceOf(LastActiveAdminError);
    expect(clientQuery.mock.calls[1][0]).toContain('active-admin-invariant');
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('allows another Admin when the active-Admin invariant permits deletion', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...storedRow, roles: ['admin'] }] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({ rows: [{ present: false }] })
      .mockResolvedValue({ rows: [] });
    await expect(User.deleteControlled(storedRow.id)).resolves.toBe(true);
  });

  it('returns not found transactionally and rolls back any deletion failure', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(User.deleteControlled('missing')).resolves.toBe(false);
    expect(clientQuery).toHaveBeenLastCalledWith('COMMIT');

    vi.clearAllMocks();
    connect.mockResolvedValue({ query: clientQuery, release });
    clientQuery.mockImplementation(async (statement: string) => {
      if (statement.startsWith('SELECT users')) return { rows: [storedRow] };
      if (statement.startsWith('SELECT EXISTS')) return { rows: [{ present: false }] };
      if (statement.startsWith('DELETE FROM users')) throw new Error('database failure');
      return { rows: [] };
    });
    await expect(User.deleteControlled(storedRow.id)).rejects.toThrow('database failure');
    expect(clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
  });
});
