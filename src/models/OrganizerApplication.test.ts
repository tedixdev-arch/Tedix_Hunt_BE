import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), clientQuery: vi.fn(), release: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({ pool: { query: mocks.query, connect: mocks.connect } }));

import { OrganizerApplications } from './OrganizerApplication.js';

const input = {
  name: 'Ada', email: 'ADA@example.com', organizationName: 'Academy',
  organizationType: 'school' as const, reason: 'Education', phone: null,
  passwordHash: '$2a$10$hashed',
};
const applicationRow = {
  id: 'application-1', name: 'Ada', email: 'ada@example.com',
  organization_name: 'Academy', organization_type: 'school', reason: 'Education',
  phone: null, status: 'pending', user_id: 'user-1', organization_id: null,
  created_at: new Date(), updated_at: new Date(), reviewed_at: null, reviewed_by: null,
};

describe('OrganizerApplications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  });

  it('creates a password-backed identity and pending application without persisting password data there', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', password_hash: input.passwordHash }] })
      .mockResolvedValueOnce({ rows: [applicationRow] })
      .mockResolvedValueOnce({});

    const result = await OrganizerApplications.create(input);

    expect(mocks.clientQuery.mock.calls[3]).toEqual([
      expect.stringContaining('INSERT INTO users'), ['ada@example.com', 'Ada', input.passwordHash],
    ]);
    const applicationInsert = mocks.clientQuery.mock.calls[4];
    expect(applicationInsert[0]).toContain('INSERT INTO organizer_applications');
    expect(applicationInsert[0]).not.toMatch(/password/i);
    expect(applicationInsert[1]).not.toContain(input.passwordHash);
    expect(applicationInsert[1]).toContain('user-1');
    expect(result).toMatchObject({ id: 'application-1', status: 'pending', userId: 'user-1' });
  });

  it('establishes credentials for an existing passwordless identity without changing its roles', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', password_hash: null }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [applicationRow] }).mockResolvedValueOnce({});

    await OrganizerApplications.create(input);

    expect(mocks.clientQuery).toHaveBeenNthCalledWith(4,
      'UPDATE users SET password_hash = $2 WHERE id = $1', ['user-1', input.passwordHash]);
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes('user_roles'))).toBe(false);
  });

  it('reuses a password-backed identity without resetting its password or duplicating it', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'user-1', password_hash: 'existing-hash' }] })
      .mockResolvedValueOnce({ rows: [applicationRow] }).mockResolvedValueOnce({});

    await OrganizerApplications.create(input);

    const sql = mocks.clientQuery.mock.calls.map(([query]) => String(query)).join('\n');
    expect(sql).not.toContain('UPDATE users SET password_hash');
    expect(sql).not.toContain('INSERT INTO users');
  });

  it('approves transactionally, grants capability, and creates organization membership without credentials or tokens', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ ...applicationRow, status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-1' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'org-1' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...applicationRow, status: 'approved', organization_id: 'org-1' }] })
      .mockResolvedValueOnce({});

    const approved = await OrganizerApplications.approve('application-1', 'admin-1');
    const sql = mocks.clientQuery.mock.calls.map(([query]) => String(query)).join('\n');

    expect(sql).toContain("INSERT INTO user_roles (user_id, role) VALUES ($1, 'organizer')");
    expect(sql).toContain('INSERT INTO organizations');
    expect(sql).toContain('INSERT INTO organization_members');
    expect(sql).not.toMatch(/activation_token|professional_activation_tokens|password_hash\s*=/i);
    expect(approved).toMatchObject({ status: 'approved', organizationId: 'org-1' });
  });

  it('rejects without granting organizer capability', async () => {
    mocks.clientQuery.mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ ...applicationRow, status: 'rejected' }] })
      .mockResolvedValueOnce({});

    await expect(OrganizerApplications.reject('application-1', 'admin-1'))
      .resolves.toMatchObject({ status: 'rejected' });
    expect(mocks.clientQuery.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('user_roles');
  });
});
