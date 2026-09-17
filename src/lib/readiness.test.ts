import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), query: vi.fn(), end: vi.fn(), options: vi.fn(),
  environment: { databaseUrl: 'postgresql://test:secret@localhost/tedix_test' as string | undefined },
}));
vi.mock('../config/environment.js', () => ({ environment: mocks.environment }));
vi.mock('pg', () => ({
  Client: class {
    constructor(options: unknown) { mocks.options(options); }
    connect = mocks.connect;
    query = mocks.query;
    end = mocks.end;
  },
}));
import { checkDatabaseReadiness } from './readiness.js';

describe('database readiness', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.environment.databaseUrl = 'postgresql://test:secret@localhost/tedix_test';
    mocks.connect.mockResolvedValue(undefined);
    mocks.query.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    mocks.end.mockResolvedValue(undefined);
  });

  it('uses a bounded read-only connection and closes it after SELECT 1', async () => {
    await checkDatabaseReadiness();
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({
      options: '-c default_transaction_read_only=on',
      connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000,
    }));
    expect(mocks.query.mock.calls).toEqual([['SELECT 1']]);
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it.each(['connect', 'query'] as const)('closes the connection when %s fails', async (operation) => {
    mocks[operation].mockRejectedValue(new Error('Database unavailable'));
    await expect(checkDatabaseReadiness()).rejects.toThrow('Database unavailable');
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('fails without configuration instead of connecting to a default local database', async () => {
    mocks.environment.databaseUrl = undefined;
    await expect(checkDatabaseReadiness()).rejects.toThrow('Database is not configured');
    expect(mocks.options).not.toHaveBeenCalled();
  });
});
