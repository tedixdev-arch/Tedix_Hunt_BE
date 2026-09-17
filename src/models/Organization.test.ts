import { beforeEach, describe, expect, it, vi } from 'vitest';

const { clientQuery, poolQuery, release, connect } = vi.hoisted(() => {
  const query = vi.fn();
  const releaseClient = vi.fn();
  return {
    clientQuery: query,
    poolQuery: vi.fn(),
    release: releaseClient,
    connect: vi.fn().mockResolvedValue({ query, release: releaseClient }),
  };
});

vi.mock('../lib/postgres.js', () => ({ pool: { connect, query: poolQuery } }));

import { Organization } from './Organization.js';

describe('Organization user relationships', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the owner and member user references in one transaction', async () => {
    const ownerId = '7dc65d7e-cd31-4205-b92d-c716a7ae494a';
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO organizations')) {
        return {
          rows: [{
            id: '4429356c-1df9-45cc-be06-55bb4b560985',
            name: 'Example',
            description: null,
            owner_id: ownerId,
            created_at: new Date('2026-01-02T03:04:05Z'),
          }],
        };
      }
      return { rows: [] };
    });

    const organization = await Organization.create({
      name: 'Example',
      owner: ownerId,
      members: [ownerId, ownerId],
    });

    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO organizations'),
      ['Example', null, ownerId],
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO organization_members'),
      [organization.id, ownerId],
    );
    expect(clientQuery.mock.calls.map(([sql]) => sql.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO organizations'),
      expect.stringContaining('INSERT INTO organization_members'),
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledOnce();
    expect(organization.members).toEqual([ownerId]);
  });

  it('automatically persists an omitted owner as a member', async () => {
    const ownerId = '7dc65d7e-cd31-4205-b92d-c716a7ae494a';
    clientQuery.mockImplementation(async (sql: string) => ({
      rows: sql.includes('INSERT INTO organizations')
        ? [{
            id: '4429356c-1df9-45cc-be06-55bb4b560985',
            name: 'Example',
            description: null,
            owner_id: ownerId,
            created_at: new Date('2026-01-02T03:04:05Z'),
          }]
        : [],
    }));

    const organization = await Organization.create({ name: 'Example', owner: ownerId, members: [] });

    expect(organization.members).toEqual([ownerId]);
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO organization_members'),
      [organization.id, ownerId],
    );
  });

  it('checks ownership and membership independently of global capabilities', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });

    await expect(Organization.isOwner('user-1', 'org-1')).resolves.toBe(true);
    await expect(Organization.isMember('user-2', 'org-1')).resolves.toBe(false);
    expect(poolQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('owner_id = $2'),
      ['org-1', 'user-1'],
    );
    expect(poolQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('organization_members'),
      ['org-1', 'user-2'],
    );
  });

  it('adds members idempotently and removes only a requested non-owner membership', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(Organization.addMember('org-1', 'user-1')).resolves.toBe(true);
    await expect(Organization.addMember('org-1', 'user-1')).resolves.toBe(false);
    await expect(Organization.removeMember('org-1', 'user-1')).resolves.toBe(true);

    expect(poolQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ON CONFLICT (organization_id, user_id) DO NOTHING'),
      ['org-1', 'user-1'],
    );
    expect(poolQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('NOT EXISTS'),
      ['org-1', 'user-1'],
    );
  });
});
