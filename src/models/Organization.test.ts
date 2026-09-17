import { describe, expect, it, vi } from 'vitest';

const { clientQuery, release, connect } = vi.hoisted(() => {
  const query = vi.fn();
  const releaseClient = vi.fn();
  return {
    clientQuery: query,
    release: releaseClient,
    connect: vi.fn().mockResolvedValue({ query, release: releaseClient }),
  };
});

vi.mock('../lib/postgres.js', () => ({ pool: { connect } }));

import { Organization } from './Organization.js';

describe('Organization user relationships', () => {
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
      members: [ownerId],
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
  });
});
