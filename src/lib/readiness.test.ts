import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./postgres.js', () => ({ pool: { query: mocks.query } }));
import { checkDatabaseReadiness } from './readiness.js';

describe('database readiness', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
  });

  it('checks the shared PostgreSQL pool with SELECT 1', async () => {
    await expect(checkDatabaseReadiness()).resolves.toBeUndefined();
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('reports a failed database check', async () => {
    const failure = new Error('Database unavailable');
    mocks.query.mockRejectedValue(failure);

    await expect(checkDatabaseReadiness()).rejects.toBe(failure);
  });
});
