import { beforeEach, describe, expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
vi.mock('./postgres.js', () => ({ pool: { query } }));
import { diagnoseDatabaseBinding } from './developmentDatabaseBinding.js';
const expected = { DEV_PG_SYSTEM_IDENTIFIER: '12345', DEV_PG_SERVER_ADDR: '::1', DEV_PG_SERVER_PORT: '5432' };
const good = { database_match: true, role_match: true, cluster_match: true, endpoint_match: true };
beforeEach(() => { vi.clearAllMocks(); query.mockResolvedValue({ rows: [{ ...good }] }); });
describe('running singleton Pool identity query', () => {
  it('retains the parameterized read-only query and only returns checks', async () => {
    expect(await diagnoseDatabaseBinding(expected)).toEqual({ status: 'PASS', checks: Object.fromEntries(Object.keys(good).map(k => [k, 'PASS'])) });
    expect(query).toHaveBeenCalledOnce();
    const q = query.mock.calls[0][0];
    expect(q.values).toEqual(Object.values(expected));
    expect(q.text.trim()).toMatch(/^SELECT /);
    for (const text of ['current_database()', 'current_user', 'session_user', 'pg_catalog.pg_control_system()', 'inet_server_addr()', 'inet_server_port()']) expect(q.text).toContain(text);
    expect(q.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|GRANT|SET|CREATE)\b/);
    expect(q.query_timeout).toBe(5000);
  });
  it.each(Object.keys(good))('fails a %s mismatch', async key => {
    query.mockResolvedValue({ rows: [{ ...good, [key]: false }] });
    expect(await diagnoseDatabaseBinding(expected)).toMatchObject({ status: 'FAIL', checks: { [key]: 'FAIL' } });
  });
  it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ ...good, endpoint_match: null }] }])('blocks incomplete metadata', async result => {
    query.mockResolvedValue(result); expect(await diagnoseDatabaseBinding(expected)).toEqual({ status: 'BLOCKED', code: 'IDENTITY_UNAVAILABLE' });
  });
  it.each(['42501', '08006', undefined])('sanitizes failure %s', async code => {
    query.mockRejectedValue(Object.assign(new Error('postgres://secret@private/db'), { code }));
    expect(await diagnoseDatabaseBinding(expected)).toEqual({ status: 'BLOCKED', code: code === '42501' ? 'PERMISSION_PG_METADATA' : 'IDENTITY_UNAVAILABLE' });
  });
  it.each([null, [], {}, { ...expected, DEV_PG_SERVER_ADDR: 'hostname' }, { ...expected, DEV_PG_SERVER_PORT: '65536' }, { ...expected, extra: 'secret' }, { ...expected, DEV_PG_SYSTEM_IDENTIFIER: "1' OR true" }])('rejects invalid independent values', async body => {
    expect(await diagnoseDatabaseBinding(body)).toEqual({ status: 'BLOCKED', code: 'INDEPENDENT_CONFIGURATION_REQUIRED' }); expect(query).not.toHaveBeenCalled();
  });
});
