import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../lib/postgres.js', () => ({ pool: { query } }));

import { User, USER_ROLES } from './User.js';

const storedRow = {
  id: '7dc65d7e-cd31-4205-b92d-c716a7ae494a',
  email: 'person@example.com',
  password_hash: '$2a$10$stored-hash',
  role: 'participant',
  name: 'Person',
  is_guest: false,
  tedix_user_id: null,
  created_at: new Date('2026-01-02T03:04:05Z'),
};

describe('User persistence', () => {
  beforeEach(() => query.mockReset());

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
    expect(USER_ROLES).toEqual(['creator', 'participant', 'guest']);

    await expect(User.create({ role: 'administrator' as never })).rejects.toThrow(
      'invalid_user_role',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
