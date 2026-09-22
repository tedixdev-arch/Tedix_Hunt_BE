import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type UserRow = {
  id: string; email: string; password_hash: string | null; role: string;
  name: string | null; is_guest: boolean; tedix_user_id: string | null; created_at: Date;
};
type TokenRow = {
  user_id: string; token_hash: string; purpose: string; expires_at: Date;
  consumed_at: Date | null; created_by: string;
};
type State = { users: UserRow[]; roles: Map<string, Set<string>>; tokens: TokenRow[] };

const mocks = vi.hoisted(() => ({ connect: vi.fn(), poolQuery: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({
  pool: { connect: mocks.connect, query: mocks.poolQuery },
}));

import {
  ActivationAlreadyPendingError,
  AdminProvisioning,
  GuestPromotionError,
} from './AdminProvisioning.js';

const creatorId = '00000000-0000-0000-0000-000000000001';
const baseUser = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: '00000000-0000-0000-0000-000000000002', email: 'person@example.com',
  password_hash: null, role: 'participant', name: 'Person', is_guest: false,
  tedix_user_id: null, created_at: new Date('2026-01-01T00:00:00Z'), ...overrides,
});

const cloneState = (state: State): State => ({
  users: state.users.map((user) => ({ ...user })),
  roles: new Map([...state.roles].map(([id, roles]) => [id, new Set(roles)])),
  tokens: state.tokens.map((token) => ({ ...token })),
});

function database(initial: Partial<State> = {}, failOn?: string) {
  let state: State = {
    users: initial.users ?? [], roles: initial.roles ?? new Map(), tokens: initial.tokens ?? [],
  };
  let snapshot: State | undefined;
  const query = vi.fn(async (sql: string, values: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (failOn && normalized.includes(failOn)) throw new Error('injected_database_failure');
    if (normalized === 'BEGIN') { snapshot = cloneState(state); return { rows: [] }; }
    if (normalized === 'COMMIT') { snapshot = undefined; return { rows: [] }; }
    if (normalized === 'ROLLBACK') {
      if (snapshot) state = snapshot;
      snapshot = undefined;
      return { rows: [] };
    }
    if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (normalized.startsWith('SELECT * FROM users WHERE email')) {
      return { rows: state.users.filter((user) => user.email === values[0]).slice(0, 1) };
    }
    if (normalized.startsWith('INSERT INTO users')) {
      const row = baseUser({
        id: `00000000-0000-0000-0000-${String(state.users.length + 10).padStart(12, '0')}`,
        email: values[0], name: values[1], password_hash: null,
      });
      state.users.push(row);
      return { rows: [row] };
    }
    if (normalized.startsWith('INSERT INTO user_roles')) {
      const roles = state.roles.get(values[0]) ?? new Set<string>();
      roles.add('admin');
      state.roles.set(values[0], roles);
      return { rows: [] };
    }
    if (normalized.startsWith('UPDATE professional_activation_tokens SET consumed_at = now() WHERE user_id')) {
      for (const token of state.tokens) {
        if (token.user_id === values[0] && token.purpose === 'admin_activation'
            && !token.consumed_at && token.expires_at <= new Date()) token.consumed_at = new Date();
      }
      return { rows: [] };
    }
    if (normalized.startsWith('SELECT 1 FROM professional_activation_tokens')) {
      return { rows: state.tokens.some((token) => token.user_id === values[0]
        && token.purpose === 'admin_activation' && !token.consumed_at && token.expires_at > new Date())
        ? [{ '?column?': 1 }] : [] };
    }
    if (normalized.startsWith('INSERT INTO professional_activation_tokens')) {
      state.tokens.push({ user_id: values[0], token_hash: values[1], purpose: 'admin_activation',
        expires_at: values[2], created_by: values[3], consumed_at: null });
      return { rows: [] };
    }
    if (normalized.startsWith('UPDATE professional_activation_tokens SET consumed_at = now() WHERE token_hash')) {
      const token = state.tokens.find((item) => item.token_hash === values[0]
        && item.purpose === 'admin_activation' && !item.consumed_at && item.expires_at > new Date());
      if (!token) return { rows: [] };
      token.consumed_at = new Date();
      return { rows: [{ user_id: token.user_id }] };
    }
    if (normalized.startsWith('UPDATE users SET password_hash')) {
      const user = state.users.find((item) => item.id === values[0] && item.password_hash === null);
      if (!user) return { rows: [] };
      user.password_hash = values[1];
      return { rows: [user] };
    }
    if (normalized.startsWith('SELECT users.*, ARRAY')) {
      const user = state.users.find((item) => item.id === values[0]);
      return { rows: user ? [{ ...user, roles: [...(state.roles.get(user.id) ?? [])].sort() }] : [] };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  });
  const client = { query, release: vi.fn() };
  mocks.connect.mockResolvedValue(client);
  return { client, get state() { return state; } };
}

describe('AdminProvisioning', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves a password-backed user and roles while adding Admin idempotently without activation', async () => {
    const existing = baseUser({ password_hash: '$2a$10$existing-password-hash' });
    const db = database({ users: [existing], roles: new Map([[existing.id, new Set(['creator', 'admin'])]]) });
    const result = await AdminProvisioning.provision(' PERSON@EXAMPLE.COM ', undefined, creatorId);
    expect(result).toMatchObject({ activationRequired: false });
    expect(result).not.toHaveProperty('activationToken');
    expect(db.state.users[0].password_hash).toBe('$2a$10$existing-password-hash');
    expect([...db.state.roles.get(existing.id)!].sort()).toEqual(['admin', 'creator']);
    expect(db.state.tokens).toEqual([]);
  });

  it('creates a passwordless Admin and persists only a hashed, expiring token with its creator', async () => {
    const db = database();
    const before = Date.now();
    const result = await AdminProvisioning.provision(' NEW@EXAMPLE.COM ', 'New Admin', creatorId);
    expect(db.state.users[0]).toMatchObject({ email: 'new@example.com', password_hash: null });
    expect(db.state.roles.get(db.state.users[0].id)).toEqual(new Set(['admin']));
    expect(result.activationRequired).toBe(true);
    expect(result.activationToken).toEqual(expect.any(String));
    const stored = db.state.tokens[0];
    expect(stored.token_hash).toBe(crypto.createHash('sha256').update(result.activationToken!).digest('hex'));
    expect(stored.token_hash).not.toBe(result.activationToken);
    expect(stored.expires_at.getTime()).toBeGreaterThan(before);
    expect(stored.created_by).toBe(creatorId);
  });

  it('adds Admin and activation to an existing passwordless user without removing roles', async () => {
    const existing = baseUser();
    const db = database({ users: [existing], roles: new Map([[existing.id, new Set(['organizer'])]]) });
    const result = await AdminProvisioning.provision(existing.email, undefined, creatorId);
    expect(result.activationRequired).toBe(true);
    expect(result.user.roles).toEqual(['admin', 'organizer']);
    expect(db.state.roles.get(existing.id)).toEqual(new Set(['organizer', 'admin']));
  });

  it('conflicts on a valid pending activation without creating a second token', async () => {
    const existing = baseUser();
    const pending: TokenRow = { user_id: existing.id, token_hash: 'pending', purpose: 'admin_activation',
      expires_at: new Date(Date.now() + 60_000), consumed_at: null, created_by: creatorId };
    const db = database({ users: [existing], tokens: [pending] });
    await expect(AdminProvisioning.provision(existing.email, undefined, creatorId))
      .rejects.toBeInstanceOf(ActivationAlreadyPendingError);
    expect(db.state.tokens).toHaveLength(1);
    expect(db.state.roles.size).toBe(0); // the role assignment was rolled back with the conflict
  });

  it('retires an expired activation before issuing its replacement', async () => {
    const existing = baseUser();
    const expired: TokenRow = { user_id: existing.id, token_hash: 'expired', purpose: 'admin_activation',
      expires_at: new Date(Date.now() - 60_000), consumed_at: null, created_by: creatorId };
    const db = database({ users: [existing], tokens: [expired] });
    const result = await AdminProvisioning.provision(existing.email, undefined, creatorId);
    expect(result.activationRequired).toBe(true);
    expect(db.state.tokens).toHaveLength(2);
    expect(db.state.tokens[0].consumed_at).toBeInstanceOf(Date);
    expect(db.state.tokens[1].consumed_at).toBeNull();
  });

  it('atomically activates once with a bcrypt password while preserving authoritative roles', async () => {
    const existing = baseUser();
    const plaintext = 'activation-secret';
    const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex');
    const db = database({ users: [existing], roles: new Map([[existing.id, new Set(['organizer', 'admin'])]]),
      tokens: [{ user_id: existing.id, token_hash: tokenHash, purpose: 'admin_activation',
        expires_at: new Date(Date.now() + 60_000), consumed_at: null, created_by: creatorId }] });
    const passwordHash = await bcrypt.hash('new-password', 4);
    const activated = await AdminProvisioning.activate(tokenHash, passwordHash);
    expect(activated?.roles).toEqual(['admin', 'organizer']);
    await expect(bcrypt.compare('new-password', db.state.users[0].password_hash!)).resolves.toBe(true);
    expect(db.state.tokens[0].consumed_at).toBeInstanceOf(Date);
    await expect(AdminProvisioning.activate(tokenHash, passwordHash)).resolves.toBeNull();
    expect(db.state.tokens).toHaveLength(1);
  });

  it('rejects expired activation without setting a password or consuming it', async () => {
    const existing = baseUser();
    const db = database({ users: [existing], tokens: [{ user_id: existing.id, token_hash: 'expired',
      purpose: 'admin_activation', expires_at: new Date(Date.now() - 1), consumed_at: null,
      created_by: creatorId }] });
    await expect(AdminProvisioning.activate('expired', 'bcrypt-hash')).resolves.toBeNull();
    expect(db.state.users[0].password_hash).toBeNull();
    expect(db.state.tokens[0].consumed_at).toBeNull();
  });

  it('rejects a guest before any role or token mutation', async () => {
    const guest = baseUser({ is_guest: true });
    const db = database({ users: [guest], roles: new Map([[guest.id, new Set(['participant'])]]) });
    await expect(AdminProvisioning.provision(guest.email, undefined, creatorId))
      .rejects.toBeInstanceOf(GuestPromotionError);
    expect(db.state.roles.get(guest.id)).toEqual(new Set(['participant']));
    expect(db.state.tokens).toEqual([]);
  });

  it.each(['INSERT INTO user_roles', 'INSERT INTO professional_activation_tokens'])
  ('rolls back a new user and every mutation when %s fails', async (failure) => {
    const db = database({}, failure);
    await expect(AdminProvisioning.provision('new@example.com', 'New', creatorId))
      .rejects.toThrow('injected_database_failure');
    expect(db.state.users).toEqual([]);
    expect(db.state.roles.size).toBe(0);
    expect(db.state.tokens).toEqual([]);
    expect(db.client.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
