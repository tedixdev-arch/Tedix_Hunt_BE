import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({ pool: { query } }));

import { HuntContext } from './HuntContext.js';

describe('Hunt context persistence', () => {
  beforeEach(() => query.mockReset());

  it('maps one combined context per Hunt without leaking unrelated Hunt data', async () => {
    query.mockResolvedValueOnce({ rows: [{
      hunt_id: 'hunt-1', hunt_name: 'Shared Hunt', hunt_status: 'active',
      participant: true, supervisor: true,
      access_code: 'MUST-NOT-LEAK', organization_id: 'org-1',
    }] });

    await expect(HuntContext.findForUser('user-1')).resolves.toEqual([{
      huntId: 'hunt-1', huntName: 'Shared Hunt', huntStatus: 'active',
      participant: true, supervisor: true,
    }]);
  });

  it('derives access only from enrollment and the Hunt-specific supervisor role', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(HuntContext.findForUser('user-1')).resolves.toEqual([]);

    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toMatch(/FROM hunt_participants\s+WHERE user_id = \$1/);
    expect(sql).toMatch(/FROM hunt_roles\s+WHERE user_id = \$1 AND role = 'supervisor'/);
    expect(sql).not.toContain('user_roles');
    expect(sql).not.toMatch(/created_by_user_id|organization_members/);
    expect(parameters).toEqual(['user-1']);
  });

  it('groups duplicate Hunt access and applies the required deterministic ordering', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await HuntContext.findForUser('user-1');

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/bool_or\(participant\)[\s\S]*bool_or\(supervisor\)[\s\S]*GROUP BY hunt_id/);
    expect(sql).toMatch(/WHEN 'active' THEN 1[\s\S]*WHEN 'paused' THEN 2[\s\S]*WHEN 'published' THEN 3[\s\S]*WHEN 'draft' THEN 4[\s\S]*WHEN 'finished' THEN 5[\s\S]*WHEN 'cancelled' THEN 6/);
    expect(sql).toMatch(/h\.updated_at DESC,\s*h\.created_at DESC/);
  });
});
