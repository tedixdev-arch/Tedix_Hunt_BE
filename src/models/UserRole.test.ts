import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({ pool: { query } }));

import { RetiredAccountRoleError, UserRoles } from './UserRole.js';

describe('UserRoles persistence', () => {
  beforeEach(() => query.mockReset());

  it('reads multiple roles and checks an individual role', async () => {
    query.mockResolvedValueOnce({ rows: [{ role: 'creator' }, { role: 'participant' }] });
    await expect(UserRoles.getRolesForUser('user-1')).resolves.toEqual([
      'creator',
      'participant',
    ]);

    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    await expect(UserRoles.hasRole('user-1', 'creator')).resolves.toBe(true);
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(UserRoles.hasRole('user-1', 'admin')).resolves.toBe(false);
  });

  it('repeats grants and removals idempotently while touching only the requested role row', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await UserRoles.assignRole('user-1', 'organizer');
    await UserRoles.assignRole('user-1', 'organizer');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT DO NOTHING'), [
      'user-1',
      'organizer',
    ]);

    await UserRoles.removeRole('user-1', 'creator');
    await UserRoles.removeRole('user-1', 'creator');
    expect(query).toHaveBeenLastCalledWith(
      'DELETE FROM user_roles WHERE user_id = $1 AND role = $2',
      ['user-1', 'creator'],
    );
    // The users read is only an account-state guard; no domain record participates.
    expect(query.mock.calls.every(([sql]) => /user_roles|users/.test(sql))).toBe(true);
  });

  it('never grants a capability to a retired identity', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ account_status: 'retired' }], rowCount: 1 });

    await expect(UserRoles.assignRole('retired-user', 'admin'))
      .rejects.toBeInstanceOf(RetiredAccountRoleError);
    expect(query.mock.calls[0][0]).toContain("account_status <> 'retired'");
  });

  it('rejects unsupported global roles', async () => {
    await expect(UserRoles.assignRole('user-1', 'supervisor' as never)).rejects.toThrow(
      'invalid_user_role',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
