import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
vi.mock('../lib/postgres.js', () => ({ pool: { query } }));

import { HuntTemplates } from './HuntTemplate.js';

describe('approved Hunt Template catalog persistence', () => {
  beforeEach(() => query.mockReset());

  it('lists approved Templates and maps their latest persisted versions', async () => {
    query.mockResolvedValue({ rows: [{
      key: 'signal-cluj-napoca', version: 1,
      content: { displayName: 'Signal from PostgreSQL' },
    }] });

    await expect(HuntTemplates.listApprovedWithLatestVersion()).resolves.toEqual([{
      key: 'signal-cluj-napoca', version: 1,
      content: { displayName: 'Signal from PostgreSQL' },
    }]);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("t.status = 'approved'");
    expect(sql).toContain('ORDER BY version DESC');
    expect(sql).toContain('ORDER BY t.key ASC');
  });

  it('finds only an approved key and returns null when PostgreSQL has no row', async () => {
    query.mockResolvedValueOnce({ rows: [{ key: 'approved', version: 3, content: { ok: true } }] });
    await expect(HuntTemplates.findApprovedByKeyWithLatestVersion('approved')).resolves.toEqual({
      key: 'approved', version: 3, content: { ok: true },
    });
    expect(query.mock.calls[0][0]).toContain("t.status = 'approved' AND t.key = $1");
    expect(query.mock.calls[0][1]).toEqual(['approved']);

    query.mockResolvedValueOnce({ rows: [] });
    await expect(HuntTemplates.findApprovedByKeyWithLatestVersion('draft')).resolves.toBeNull();
  });
});
