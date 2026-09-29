import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
vi.mock('../lib/postgres.js', () => ({ pool: { query, connect } }));

import { HuntTemplateKeyConflictError, HuntTemplates } from './HuntTemplate.js';

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

describe('Creator Hunt Template persistence', () => {
  const creatorId = 'creator-1';
  const templateRow = {
    id: 'template-1', key: 'algebra-trail', origin: 'creator', created_by_user_id: creatorId,
    status: 'draft', created_at: new Date(), updated_at: new Date(),
  };
  const content = {
    key: 'algebra-trail', version: 1, displayName: 'Algebra Trail', theme: 'Numbers',
    mission: { name: 'Go' }, configuration: { duration: 30 }, scoring: { start: 10 },
    checkpoints: [{ id: 'one', custom: { preserved: true } }],
  };

  it('atomically creates identity and immutable v1 with the same Creator provenance', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [templateRow] })
      .mockResolvedValueOnce({ rows: [{
        id: 'version-1', template_id: templateRow.id, version: 1, content,
        origin: 'creator', created_by_user_id: creatorId, created_at: new Date(),
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await HuntTemplates.createCreatorDraft(templateRow.key, content, creatorId);

    expect(result.version.content).toEqual(content);
    expect(result.template).toMatchObject({ origin: 'creator', status: 'draft', createdByUserId: creatorId });
    expect(result.version).toMatchObject({ version: 1, origin: 'creator', createdByUserId: creatorId });
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s/)[0])).toEqual([
      'BEGIN', 'INSERT', 'INSERT', 'COMMIT',
    ]);
    expect(client.query.mock.calls[2][1]).toEqual([templateRow.id, content, creatorId]);
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back identity creation when version creation fails', async () => {
    const failure = new Error('version failed');
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValue(client);
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [templateRow] })
      .mockRejectedValueOnce(failure).mockResolvedValueOnce({ rows: [] });

    await expect(HuntTemplates.createCreatorDraft(templateRow.key, content, creatorId)).rejects.toBe(failure);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('maps unique violations to a stable conflict error and rolls back', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValue(client);
    client.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce({ code: '23505' })
      .mockResolvedValueOnce({ rows: [] });

    await expect(HuntTemplates.createCreatorDraft(templateRow.key, content, creatorId))
      .rejects.toBeInstanceOf(HuntTemplateKeyConflictError);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
