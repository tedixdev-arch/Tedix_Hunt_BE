import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return { query, release: vi.fn(), connect: vi.fn(async () => ({ query, release: mocks.release })) };
});
vi.mock('../lib/postgres.js', () => ({
  pool: { query: mocks.query, connect: mocks.connect },
}));

import { LastAdminError, UserRoles } from './UserRole.js';

describe('final active Admin invariant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rolls back instead of removing the final active Admin', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [{ count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(UserRoles.removeRole('last-admin', 'admin')).rejects.toBeInstanceOf(LastAdminError);
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM user_roles'), expect.anything(),
    );
    expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK');
  });

  it('allows removal when another active Admin remains', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await UserRoles.removeRole('one-of-two', 'admin');
    expect(mocks.query).toHaveBeenCalledWith(
      "DELETE FROM user_roles WHERE user_id = $1 AND role = 'admin'", ['one-of-two'],
    );
    expect(mocks.query).toHaveBeenLastCalledWith('COMMIT');
  });
});
