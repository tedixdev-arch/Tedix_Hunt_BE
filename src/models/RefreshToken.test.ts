import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../lib/postgres.js', () => ({ pool: { query } }));

import { RefreshToken } from './RefreshToken.js';

const storedRow = {
  id: '740cbac8-9af6-49f5-a6ca-808de3e08767',
  user_id: '7dc65d7e-cd31-4205-b92d-c716a7ae494a',
  token: 'opaque-refresh-token',
  expires_at: new Date('2026-10-01T00:00:00Z'),
  created_at: new Date('2026-09-17T00:00:00Z'),
};

describe('RefreshToken persistence', () => {
  beforeEach(() => query.mockReset());

  it('persists the user association and expiry', async () => {
    query.mockResolvedValue({ rows: [storedRow] });

    await expect(
      RefreshToken.create({
        user: storedRow.user_id,
        token: storedRow.token,
        expiresAt: storedRow.expires_at,
      }),
    ).resolves.toMatchObject({ user: storedRow.user_id, expiresAt: storedRow.expires_at });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO refresh_tokens'), [
      storedRow.user_id,
      storedRow.token,
      storedRow.expires_at,
    ]);
  });

  it('atomically consumes a refresh token', async () => {
    query.mockResolvedValue({ rows: [storedRow] });

    await expect(RefreshToken.consume(storedRow.token)).resolves.toMatchObject({
      id: storedRow.id,
      token: storedRow.token,
    });
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM refresh_tokens WHERE token = $1 RETURNING *',
      [storedRow.token],
    );
  });

  it('does not create a session unless PostgreSQL says the account is active', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(RefreshToken.create({
      user: storedRow.user_id, token: 'blocked-token', expiresAt: storedRow.expires_at,
    })).resolves.toBeNull();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("account_status = 'active'"), [
      storedRow.user_id, 'blocked-token', storedRow.expires_at,
    ]);
  });
});
