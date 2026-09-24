import { pool } from '../lib/postgres.js';

import type { UserRole } from './UserRole.js';

export type LegacyRole = 'creator' | 'participant' | 'guest';
export type AccountStatus = 'active' | 'blocked';

export interface IUser {
  id: string;
  email?: string | null;
  passwordHash?: string | null;
  role: LegacyRole;
  roles: UserRole[];
  name?: string | null;
  isGuest: boolean;
  tedixUserId?: string | null;
  accountStatus: AccountStatus;
  createdAt: Date;
}

export interface CreateUserInput {
  email?: string;
  passwordHash?: string;
  role: Extract<UserRole, 'creator' | 'participant'>;
  name?: string;
  isGuest?: boolean;
  tedixUserId?: string;
}

export interface FindUserFilter {
  id?: string;
  email?: string;
  tedixUserId?: string;
  role?: Extract<UserRole, 'creator' | 'participant'>;
}

export interface UpdateUserIdentityInput {
  name?: string | null;
  email?: string;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function assertInitialRole(role: string): asserts role is CreateUserInput['role'] {
  // Public registration can establish only its existing creator or participant capability.
  if (role !== 'creator' && role !== 'participant') throw new Error('invalid_user_role');
}

const mapRow = (row: any): IUser => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  role: row.role,
  roles: row.roles ?? [],
  name: row.name,
  isGuest: row.is_guest,
  tedixUserId: row.tedix_user_id,
  accountStatus: row.account_status ?? 'active',
  createdAt: row.created_at,
});

export class LastActiveAdminError extends Error {}

export const User = {
  async create(input: CreateUserInput): Promise<IUser> {
    assertInitialRole(input.role);
    const { rows } = await pool.query(
      `WITH new_user AS (
         INSERT INTO users (email, password_hash, role, name, is_guest, tedix_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *
       ), assigned_role AS (
         INSERT INTO user_roles (user_id, role)
         SELECT id, $3 FROM new_user
       )
       SELECT new_user.*, ARRAY[$3]::text[] AS roles FROM new_user`,
      [
        input.email === undefined ? null : normalizeEmail(input.email),
        input.passwordHash ?? null,
        input.role,
        input.name ?? null,
        input.isGuest ?? false,
        input.tedixUserId ?? null,
      ],
    );
    return mapRow(rows[0]);
  },

  async findOne(filter: FindUserFilter): Promise<IUser | null> {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (filter.id !== undefined) {
      values.push(filter.id);
      clauses.push(`id = $${values.length}`);
    }
    if (filter.email !== undefined) {
      values.push(normalizeEmail(filter.email));
      clauses.push(`email = $${values.length}`);
    }
    if (filter.tedixUserId !== undefined) {
      values.push(filter.tedixUserId);
      clauses.push(`tedix_user_id = $${values.length}`);
    }
    if (filter.role !== undefined) {
      values.push(filter.role);
      clauses.push(`EXISTS (
        SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id AND ur.role = $${values.length}
      )`);
    }

    if (clauses.length === 0) return null;

    const { rows } = await pool.query(
      `SELECT users.*, ARRAY(
         SELECT ur.role FROM user_roles ur WHERE ur.user_id = users.id ORDER BY ur.role
       ) AS roles
       FROM users WHERE ${clauses.join(' AND ')} LIMIT 1`,
      values,
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async findById(id: string): Promise<IUser | null> {
    const { rows } = await pool.query(
      `SELECT users.*, ARRAY(
         SELECT ur.role FROM user_roles ur WHERE ur.user_id = users.id ORDER BY ur.role
       ) AS roles
       FROM users WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async updateIdentity(id: string, input: UpdateUserIdentityInput): Promise<IUser | null> {
    const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
    const hasEmail = Object.prototype.hasOwnProperty.call(input, 'email');
    // One UPDATE makes a combined name/email edit atomic and deliberately leaves credentials,
    // access state, roles, sessions, and all related business records untouched.
    const { rows } = await pool.query(
      `UPDATE users
       SET name = CASE WHEN $2 THEN $3 ELSE name END,
           email = CASE WHEN $4 THEN $5 ELSE email END
       WHERE id = $1
       RETURNING users.*, ARRAY(
         SELECT ur.role FROM user_roles ur WHERE ur.user_id = users.id ORDER BY ur.role
       ) AS roles`,
      [
        id,
        hasName,
        input.name ?? null,
        hasEmail,
        hasEmail ? normalizeEmail(input.email!) : null,
      ],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async changePasswordAndRevokeSessions(id: string, passwordHash: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
      await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async setAccountStatus(id: string, status: AccountStatus): Promise<IUser | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize this decision with Admin-role removal so concurrent changes cannot remove
      // every active Admin-capable identity.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('active-admin-invariant'))");
      const target = (await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!target) {
        await client.query('COMMIT');
        return null;
      }

      if (status === 'blocked' && target.account_status === 'active') {
        const isAdmin = await client.query(
          "SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [id],
        );
        if (isAdmin.rows[0]) {
          const activeAdmins = await client.query(
            `SELECT count(*)::int AS count
             FROM user_roles ur JOIN users u ON u.id = ur.user_id
             WHERE ur.role = 'admin' AND u.account_status = 'active'`,
          );
          if (activeAdmins.rows[0].count <= 1) throw new LastActiveAdminError();
        }
      }

      await client.query('UPDATE users SET account_status = $2 WHERE id = $1', [id, status]);
      // Revoke every session on block, including an idempotent repeated block.
      if (status === 'blocked') {
        await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [id]);
      }
      const row = (await client.query(
        `SELECT users.*, ARRAY(
           SELECT role FROM user_roles WHERE user_id = users.id ORDER BY role
         ) roles FROM users WHERE id = $1`, [id],
      )).rows[0];
      await client.query('COMMIT');
      return mapRow(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};

export { USER_ROLES } from './UserRole.js';
