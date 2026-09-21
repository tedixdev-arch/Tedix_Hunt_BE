import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), clientQuery: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({
  pool: { query: mocks.query, connect: mocks.connect },
}));

import { OrganizerApplications } from './OrganizerApplication.js';

describe('OrganizerApplications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: vi.fn() });
  });

  it('inserts only application data and relies on the database pending default', async () => {
    const row = {
      id: 'application-1', name: 'Ada', email: 'ada@example.com',
      organization_name: 'Academy', organization_type: 'school', reason: 'Education',
      phone: null, status: 'pending', created_at: new Date(), updated_at: new Date(),
    };
    mocks.query.mockResolvedValue({ rows: [row] });

    const result = await OrganizerApplications.create({
      name: 'Ada', email: 'ada@example.com', organizationName: 'Academy',
      organizationType: 'school', reason: 'Education', phone: null,
    });

    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO organizer_applications'), [
      'Ada', 'ada@example.com', 'Academy', 'school', 'Education', null,
    ]);
    expect(mocks.query.mock.calls[0][0]).not.toMatch(/status\s*[,) ]/i);
    expect(result).toMatchObject({
      id: 'application-1', organizationName: 'Academy', organizationType: 'school', status: 'pending',
    });
  });

  it('finds and maps an application by id', async () => {
    mocks.query.mockResolvedValue({ rows: [{
      id: 'application-1', name: 'Ada', email: 'ada@example.com',
      organization_name: 'Academy', organization_type: 'school', reason: 'Education',
      phone: null, status: 'pending', created_at: new Date(), updated_at: new Date(),
    }] });
    await expect(OrganizerApplications.findById('application-1'))
      .resolves.toMatchObject({ id: 'application-1', organizationName: 'Academy' });
  });

  const activationUser = (passwordHash: string | null, roles = ['organizer']) => ({
    id: 'user-1', email: 'ada@example.com', password_hash: passwordHash,
    role: 'organizer', roles, name: 'Ada', is_guest: false,
    tedix_user_id: null, created_at: new Date('2026-09-01T00:00:00Z'),
  });

  it('sets the supplied password when activating a newly provisioned account', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [activationUser('new-password-hash')] })
      .mockResolvedValueOnce({}); // COMMIT

    const user = await OrganizerApplications.activate('token-hash', 'new-password-hash');

    expect(mocks.clientQuery).toHaveBeenNthCalledWith(3,
      expect.stringContaining('COALESCE(password_hash, $2)'),
      ['user-1', 'new-password-hash']);
    expect(user?.passwordHash).toBe('new-password-hash');
  });

  it('preserves an existing password and all roles while adding organizer capability', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-1' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [activationUser('existing-password-hash', ['creator', 'organizer', 'participant'])],
      })
      .mockResolvedValueOnce({});

    const user = await OrganizerApplications.activate('token-hash', 'different-password-hash');

    expect(mocks.clientQuery.mock.calls[2][0]).toContain('COALESCE(password_hash, $2)');
    expect(user?.passwordHash).toBe('existing-password-hash');
    expect(user?.roles).toEqual(['creator', 'organizer', 'participant']);
  });

  it('consumes an activation token only once', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    await expect(OrganizerApplications.activate('consumed-token-hash', 'password-hash'))
      .resolves.toBeNull();
    expect(mocks.clientQuery.mock.calls[1][0]).toContain('activated_at IS NULL');
    expect(mocks.clientQuery).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
