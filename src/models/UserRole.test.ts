import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({ pool: { query } }));

import { UserRoles } from './UserRole.js';

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

  it('assigns idempotently and removes only the requested role', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await UserRoles.assignRole('user-1', 'organizer');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT DO NOTHING'), [
      'user-1',
      'organizer',
    ]);

    await UserRoles.removeRole('user-1', 'creator');
    expect(query).toHaveBeenLastCalledWith(
      'DELETE FROM user_roles WHERE user_id = $1 AND role = $2',
      ['user-1', 'creator'],
    );
  });

  it('rejects unsupported global roles', async () => {
    await expect(UserRoles.assignRole('user-1', 'supervisor' as never)).rejects.toThrow(
      'invalid_user_role',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
