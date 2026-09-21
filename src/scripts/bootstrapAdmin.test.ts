import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';
import {
  BootstrapAdminError,
  bootstrapAdmin,
  parseBootstrapArguments,
} from './bootstrapAdmin.js';

interface FakeUser {
  id: string;
  email: string;
  passwordHash: string | null;
  roles: Set<string>;
}

const fakeDatabase = (initialUsers: FakeUser[] = [], failRoleAssignment = false) => {
  let users = initialUsers.map((user) => ({ ...user, roles: new Set(user.roles) }));
  let snapshot: FakeUser[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === 'BEGIN') {
      snapshot = users.map((user) => ({ ...user, roles: new Set(user.roles) }));
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      users = snapshot;
      return { rows: [] };
    }
    if (sql === 'COMMIT' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes("FROM user_roles WHERE role = 'admin'")) {
      return { rows: users.some((user) => user.roles.has('admin')) ? [{ exists: 1 }] : [] };
    }
    if (sql.includes('FROM users WHERE email')) {
      const user = users.find(({ email }) => email === values[0]);
      return { rows: user ? [{ id: user.id, password_hash: user.passwordHash }] : [] };
    }
    if (sql.includes('INSERT INTO users')) {
      const user = {
        id: `user-${users.length + 1}`,
        email: values[0] as string,
        passwordHash: values[1] as string,
        roles: new Set<string>(),
      };
      users.push(user);
      return { rows: [{ id: user.id }] };
    }
    if (sql.includes('INSERT INTO user_roles')) {
      if (failRoleAssignment) throw new Error('role insert failed');
      users.find(({ id }) => id === values[0])?.roles.add('admin');
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return {
    database: { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as any,
    query,
    users: () => users,
  };
};

describe('bootstrapAdmin', () => {
  it('creates a normalized Admin with a bcrypt password and no unrelated roles', async () => {
    const fake = fakeDatabase();
    const result = await bootstrapAdmin({
      email: '  FIRST.Admin@Example.COM ', password: 'secure-password', name: ' First Admin ',
    }, fake.database);

    expect(result).toEqual({ email: 'first.admin@example.com', userId: 'user-1' });
    expect(fake.users()[0].roles).toEqual(new Set(['admin']));
    expect(await bcrypt.compare('secure-password', fake.users()[0].passwordHash!)).toBe(true);
    const insert = fake.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO users'))!;
    expect(insert[0]).toContain("VALUES ($1, $2, 'creator', $3, FALSE)");
    expect(insert[1]).toEqual(['first.admin@example.com', expect.any(String), 'First Admin']);
  });

  it('adds Admin idempotently without changing an existing password or roles', async () => {
    const storedHash = await bcrypt.hash('original-password', 4);
    const fake = fakeDatabase([{
      id: 'existing', email: 'person@example.com', passwordHash: storedHash,
      roles: new Set(['participant', 'creator']),
    }]);

    await bootstrapAdmin({ email: 'person@example.com', password: 'ignored-password' }, fake.database);
    await bootstrapAdmin({
      email: 'person@example.com', password: 'ignored-password', allowAdditionalAdmin: true,
    }, fake.database);

    expect(fake.users()[0].passwordHash).toBe(storedHash);
    expect(fake.users()[0].roles).toEqual(new Set(['participant', 'creator', 'admin']));
    expect(fake.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO users'))).toHaveLength(0);
  });

  it('rejects an existing passwordless identity without assigning Admin', async () => {
    const fake = fakeDatabase([{
      id: 'passwordless', email: 'person@example.com', passwordHash: null,
      roles: new Set(['organizer']),
    }]);

    await expect(bootstrapAdmin({
      email: 'person@example.com', password: 'new-password',
    }, fake.database)).rejects.toThrow('will not set or reset');
    expect(fake.users()[0].roles).toEqual(new Set(['organizer']));
  });

  it('requires the recovery flag after an Admin exists', async () => {
    const fake = fakeDatabase([{
      id: 'admin', email: 'admin@example.com', passwordHash: 'hash', roles: new Set(['admin']),
    }]);

    await expect(bootstrapAdmin({
      email: 'second@example.com', password: 'secure-password',
    }, fake.database)).rejects.toThrow('An Admin already exists');
    await expect(bootstrapAdmin({
      email: 'second@example.com', password: 'secure-password', allowAdditionalAdmin: true,
    }, fake.database)).resolves.toMatchObject({ email: 'second@example.com' });
  });

  it('rolls back new-user creation when authoritative role assignment fails', async () => {
    const fake = fakeDatabase([], true);
    await expect(bootstrapAdmin({
      email: 'admin@example.com', password: 'secure-password',
    }, fake.database)).rejects.toThrow('role insert failed');
    expect(fake.users()).toHaveLength(0);
    expect(fake.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('validates CLI input without including password values in errors', () => {
    const secret = 'secret-value';
    expect(() => parseBootstrapArguments(['--email', '', '--password', secret]))
      .toThrow(BootstrapAdminError);
    try {
      parseBootstrapArguments(['--email', '', '--password', secret]);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(() => parseBootstrapArguments([secret])).toThrow('Unknown argument provided');
    try {
      parseBootstrapArguments([secret]);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    expect(() => parseBootstrapArguments([
      '--email', 'admin@example.com', '--password', 'short',
    ])).toThrow('at least 8 characters');
    expect(() => parseBootstrapArguments([
      '--email', 'admin@example.com', '--password', 'long-enough', '--name', '   ',
    ])).toThrow('--name must be non-empty');
  });
});
