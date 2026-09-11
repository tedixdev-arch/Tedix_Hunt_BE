import { describe, expect, it } from 'vitest';
import { readDatabaseConfig } from './database.js';

describe('PostgreSQL configuration', () => {
  it('requires an explicit database, without falling back to local pg defaults', () => {
    expect(() => readDatabaseConfig({})).toThrow('DATABASE_URL is required');
  });
  it.each(['https://user:secret@localhost/db', 'postgresql://localhost', 'secret'])('rejects invalid URLs without exposing them', (value) => {
    expect(() => readDatabaseConfig({ DATABASE_URL: value })).toThrow('DATABASE_URL must be a PostgreSQL URL');
  });
  it.each(['0', '-1', '1.5', '101', 'invalid'])('rejects invalid pool limits: %s', (value) => {
    expect(() => readDatabaseConfig({ DATABASE_URL: 'postgresql://localhost/test', PGPOOL_MAX: value })).toThrow('PGPOOL_MAX');
  });
  it('accepts PostgreSQL URLs and bounds connection and query waits', () => {
    expect(readDatabaseConfig({ DATABASE_URL: 'postgresql://localhost/test', PGPOOL_MAX: '4' })).toMatchObject({
      max: 4, connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000,
    });
  });
});
