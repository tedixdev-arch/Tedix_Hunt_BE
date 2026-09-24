import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), poolQuery: vi.fn() }));
vi.mock('../lib/postgres.js', () => ({
  pool: { connect: mocks.connect, query: mocks.poolQuery },
}));

import {
  ProfessionalActivationAlreadyPendingError,
  ProfessionalGuestPromotionError,
  ProfessionalProvisioning,
} from './ProfessionalProvisioning.js';

const existing = {
  id: '00000000-0000-0000-0000-000000000001', email: 'person@example.com',
  password_hash: '$existing', role: 'participant', name: 'Person', is_guest: false,
  tedix_user_id: null, created_at: new Date('2026-01-01T00:00:00Z'),
};
const createdBy = '00000000-0000-0000-0000-000000000099';

const clientWith = (handler: (sql: string, values: any[]) => any) => {
  const query = vi.fn(async (sql: string, values: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)
        || normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    return handler(normalized, values);
  });
  mocks.connect.mockResolvedValue({ query, release: vi.fn() });
  return query;
};

describe('ProfessionalProvisioning', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves a password and existing roles while granting Creator without activation', async () => {
    const query = clientWith((sql) => {
      if (sql.startsWith('SELECT * FROM users WHERE email')) return { rows: [existing] };
      if (sql.startsWith('INSERT INTO user_roles')) return { rows: [] };
      if (sql.startsWith('SELECT users.*, ARRAY')) {
        return { rows: [{ ...existing, roles: ['admin', 'creator', 'participant'] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const result = await ProfessionalProvisioning.provision({
      email: ' PERSON@EXAMPLE.COM ', role: 'creator', createdBy,
    });
    expect(result).toMatchObject({ role: 'creator', activationRequired: false });
    expect(result.user.passwordHash).toBe('$existing');
    expect(result.user.roles).toEqual(['admin', 'creator', 'participant']);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('professional_activation_tokens')))
      .toBe(false);
  });

  it('creates an Organizer, membership, and digest-only one-time activation in one transaction', async () => {
    const passwordless = { ...existing, password_hash: null };
    let storedDigest: string | undefined;
    const query = clientWith((sql, values) => {
      if (sql.startsWith('SELECT * FROM users WHERE email')) return { rows: [] };
      if (sql.startsWith('INSERT INTO users')) return { rows: [passwordless] };
      if (sql.startsWith('INSERT INTO user_roles') || sql.startsWith('UPDATE professional_activation_tokens')) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT 1 FROM professional_activation_tokens')) return { rows: [] };
      if (sql.startsWith('INSERT INTO professional_activation_tokens')) {
        storedDigest = values[1]; return { rows: [] };
      }
      if (sql.startsWith('SELECT id, name FROM organizations')) return { rows: [] };
      if (sql.startsWith('INSERT INTO organizations')) {
        return { rows: [{ id: '00000000-0000-0000-0000-000000000010', name: values[0] }] };
      }
      if (sql.startsWith('INSERT INTO organization_members')) return { rows: [] };
      if (sql.startsWith('SELECT users.*, ARRAY')) {
        return { rows: [{ ...passwordless, roles: ['organizer'] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const result = await ProfessionalProvisioning.provision({
      email: existing.email, role: 'organizer', organizationName: 'Direct Org', createdBy,
    });
    expect(result).toMatchObject({
      activationRequired: true, role: 'organizer', organization: { name: 'Direct Org' },
    });
    expect(storedDigest).toBe(crypto.createHash('sha256').update(result.activationToken!).digest('hex'));
    expect(storedDigest).not.toBe(result.activationToken);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('organizer_applications'))).toBe(false);
  });

  it('reuses an owned Organization on identical retries but permits a different name', async () => {
    const organizations: Array<{ id: string; name: string; ownerId: string }> = [];
    const memberships = new Set<string>();
    const query = clientWith((sql, values) => {
      if (sql.startsWith('SELECT * FROM users WHERE email')) return { rows: [existing] };
      if (sql.startsWith('INSERT INTO user_roles')) return { rows: [] };
      if (sql.startsWith('SELECT id, name FROM organizations')) {
        const match = organizations.find((org) => org.ownerId === values[0]
          && org.name.trim().toLowerCase() === values[1].trim().toLowerCase());
        return { rows: match ? [{ id: match.id, name: match.name }] : [] };
      }
      if (sql.startsWith('INSERT INTO organizations')) {
        const org = {
          id: `00000000-0000-0000-0000-${String(organizations.length + 10).padStart(12, '0')}`,
          name: values[0], ownerId: values[1],
        };
        organizations.push(org);
        return { rows: [{ id: org.id, name: org.name }] };
      }
      if (sql.startsWith('INSERT INTO organization_members')) {
        memberships.add(`${values[0]}:${values[1]}`);
        return { rows: [] };
      }
      if (sql.startsWith('SELECT users.*, ARRAY')) {
        return { rows: [{ ...existing, roles: ['admin', 'organizer'] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const first = await ProfessionalProvisioning.provision({
      email: existing.email, role: 'organizer', organizationName: ' Direct Org ', createdBy,
    });
    const retry = await ProfessionalProvisioning.provision({
      email: existing.email, role: 'organizer', organizationName: 'direct org', createdBy,
    });
    const different = await ProfessionalProvisioning.provision({
      email: existing.email, role: 'organizer', organizationName: 'Second Org', createdBy,
    });

    expect(organizations).toHaveLength(2);
    expect(retry.organization?.id).toBe(first.organization?.id);
    expect(different.organization?.id).not.toBe(first.organization?.id);
    expect(memberships).toEqual(new Set([
      `${first.organization!.id}:${existing.id}`,
      `${different.organization!.id}:${existing.id}`,
    ]));
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT INTO organizations')))
      .toHaveLength(2);
    expect(first.user.roles).toEqual(['admin', 'organizer']);
    expect(first.user.passwordHash).toBe('$existing');
  });

  it('rejects guests and never mutates their capabilities', async () => {
    const query = clientWith((sql) => {
      if (sql.startsWith('SELECT * FROM users WHERE email')) {
        return { rows: [{ ...existing, is_guest: true }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(ProfessionalProvisioning.provision({
      email: existing.email, role: 'creator', createdBy,
    })).rejects.toBeInstanceOf(ProfessionalGuestPromotionError);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO user_roles'))).toBe(false);
  });

  it('does not rotate a still-valid pending activation', async () => {
    const passwordless = { ...existing, password_hash: null };
    const query = clientWith((sql) => {
      if (sql.startsWith('SELECT * FROM users WHERE email')) return { rows: [passwordless] };
      if (sql.startsWith('INSERT INTO user_roles') || sql.startsWith('UPDATE professional_activation_tokens')) {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT 1 FROM professional_activation_tokens')) return { rows: [{ exists: 1 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(ProfessionalProvisioning.provision({
      email: existing.email, role: 'creator', createdBy,
    })).rejects.toBeInstanceOf(ProfessionalActivationAlreadyPendingError);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT INTO professional_activation_tokens')))
      .toBe(false);
  });
});
