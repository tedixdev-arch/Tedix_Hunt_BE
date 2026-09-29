import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
vi.mock('../lib/postgres.js', () => ({ pool: { query, connect } }));

import {
  HuntTemplateKeyConflictError, HuntTemplateNotEditableError, HuntTemplateNotFoundError,
  HuntTemplates, InvalidHuntTemplateContentError,
} from './HuntTemplate.js';

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

  beforeEach(() => query.mockReset());

  it('lists only owner-scoped creator Templates with latest versions in one ordered query', async () => {
    query.mockResolvedValue({ rows: [
      { key: 'approved-own', version: 4, status: 'approved', origin: 'creator', content: { latest: true } },
      { key: 'draft-own', version: 2, status: 'draft', origin: 'creator', content },
    ] });

    await expect(HuntTemplates.listCreatorOwnedWithLatestVersion(creatorId)).resolves.toEqual([
      { key: 'approved-own', version: 4, status: 'approved', origin: 'creator', content: { latest: true } },
      { key: 'draft-own', version: 2, status: 'draft', origin: 'creator', content },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("t.origin = 'creator' AND t.created_by_user_id = $1");
    expect(sql).toContain('ORDER BY version DESC');
    expect(sql).toContain('ORDER BY t.key ASC');
    expect(sql).not.toContain('t.status =');
    expect(parameters).toEqual([creatorId]);
  });

  it('finds by key only when creator origin and ownership match in PostgreSQL', async () => {
    query.mockResolvedValueOnce({ rows: [{
      key: templateRow.key, version: 3, status: 'submitted', origin: 'creator', content,
    }] });
    await expect(HuntTemplates.findCreatorOwnedByKeyWithLatestVersion(templateRow.key, creatorId))
      .resolves.toMatchObject({ key: templateRow.key, version: 3, status: 'submitted', content });
    const [sql, parameters] = query.mock.calls[0];
    expect(sql).toContain("t.origin = 'creator' AND t.created_by_user_id = $1 AND t.key = $2");
    expect(sql).toContain('ORDER BY version DESC');
    expect(parameters).toEqual([creatorId, templateRow.key]);

    query.mockResolvedValueOnce({ rows: [] });
    await expect(HuntTemplates.findCreatorOwnedByKeyWithLatestVersion('private', creatorId))
      .resolves.toBeNull();
  });

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

  it('locks ownership, allocates the next version, and inserts Creator provenance', async () => {
    const v2 = { ...content, version: 2, nested: { survives: ['jsonb'] } };
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValue(client);
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [templateRow] })
      .mockResolvedValueOnce({ rows: [{ current_version: 1 }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'version-2', template_id: templateRow.id, version: 2, content: v2,
        origin: 'creator', created_by_user_id: creatorId, created_at: new Date(),
      }] }).mockResolvedValueOnce({ rows: [] });

    await expect(HuntTemplates.createCreatorVersion(templateRow.key, v2, creatorId)).resolves
      .toMatchObject({ version: { version: 2, content: v2, createdByUserId: creatorId } });
    expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE');
    expect(client.query.mock.calls[1][0]).toContain("origin = 'creator'");
    expect(client.query.mock.calls[1][1]).toEqual([templateRow.key, creatorId]);
    expect(client.query.mock.calls[3][1]).toEqual([templateRow.id, 2, v2, creatorId]);
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s/)[0])).toEqual([
      'BEGIN', 'SELECT', 'SELECT', 'INSERT', 'COMMIT',
    ]);
  });

  it('rejects non-owned and non-editable Templates inside the transaction', async () => {
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValue(client);
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(HuntTemplates.createCreatorVersion('private', content, creatorId))
      .rejects.toBeInstanceOf(HuntTemplateNotFoundError);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');

    client.query.mockReset();
    client.query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...templateRow, status: 'submitted' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(HuntTemplates.createCreatorVersion(templateRow.key, content, creatorId))
      .rejects.toBeInstanceOf(HuntTemplateNotEditableError);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it.each([
    ['skipped', { ...content, version: 3 }],
    ['reused', content],
    ['wrong key', { ...content, key: 'wrong', version: 2 }],
    ['malformed', { ...content, version: 2, checkpoints: [] }],
  ])('rolls back %s content without inserting', async (_case, invalid) => {
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValue(client);
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [templateRow] })
      .mockResolvedValueOnce({ rows: [{ current_version: 1 }] }).mockResolvedValueOnce({ rows: [] });
    await expect(HuntTemplates.createCreatorVersion(templateRow.key, invalid, creatorId))
      .rejects.toBeInstanceOf(InvalidHuntTemplateContentError);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT'))).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('rolls back cleanly when the new immutable row cannot be inserted', async () => {
    const failure = new Error('version insert failed');
    const v2 = { ...content, version: 2 };
    const client = { query: vi.fn(), release: vi.fn() };
    connect.mockResolvedValue(client);
    client.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [templateRow] })
      .mockResolvedValueOnce({ rows: [{ current_version: 1 }] }).mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ rows: [] });

    await expect(HuntTemplates.createCreatorVersion(templateRow.key, v2, creatorId))
      .rejects.toBe(failure);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});
