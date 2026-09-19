import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../lib/postgres.js', () => ({ pool: { query } }));

import { OrganizerApplications } from './OrganizerApplication.js';

describe('OrganizerApplications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts only application data and relies on the database pending default', async () => {
    const row = {
      id: 'application-1', name: 'Ada', email: 'ada@example.com',
      organization_name: 'Academy', organization_type: 'school', reason: 'Education',
      phone: null, status: 'pending', created_at: new Date(), updated_at: new Date(),
    };
    query.mockResolvedValue({ rows: [row] });

    const result = await OrganizerApplications.create({
      name: 'Ada', email: 'ada@example.com', organizationName: 'Academy',
      organizationType: 'school', reason: 'Education', phone: null,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO organizer_applications'), [
      'Ada', 'ada@example.com', 'Academy', 'school', 'Education', null,
    ]);
    expect(query.mock.calls[0][0]).not.toMatch(/status\s*[,) ]/i);
    expect(result).toMatchObject({
      id: 'application-1', organizationName: 'Academy', organizationType: 'school', status: 'pending',
    });
  });

  it('finds and maps an application by id', async () => {
    query.mockResolvedValue({ rows: [{
      id: 'application-1', name: 'Ada', email: 'ada@example.com',
      organization_name: 'Academy', organization_type: 'school', reason: 'Education',
      phone: null, status: 'pending', created_at: new Date(), updated_at: new Date(),
    }] });
    await expect(OrganizerApplications.findById('application-1'))
      .resolves.toMatchObject({ id: 'application-1', organizationName: 'Academy' });
  });
});
