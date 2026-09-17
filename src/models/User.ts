import { pool } from '../lib/postgres.js';

export type Role = 'creator' | 'participant' | 'guest';
export const USER_ROLES: readonly Role[] = ['creator', 'participant', 'guest'];

export interface IUser {
  id: string;
  email?: string | null;
  passwordHash?: string | null;
  role: Role;
  name?: string | null;
  isGuest: boolean;
  tedixUserId?: string | null;
  createdAt: Date;
}

export interface CreateUserInput {
  email?: string;
  passwordHash?: string;
  role: Role;
  name?: string;
  isGuest?: boolean;
  tedixUserId?: string;
}

export interface FindUserFilter {
  id?: string;
  email?: string;
  tedixUserId?: string;
  role?: Role;
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function assertRole(role: string): asserts role is Role {
  // These are the roles supported by the current account model. Authorization expansion is out of scope here.
  if (!USER_ROLES.includes(role as Role)) throw new Error('invalid_user_role');
}

const mapRow = (row: any): IUser => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  role: row.role,
  name: row.name,
  isGuest: row.is_guest,
  tedixUserId: row.tedix_user_id,
  createdAt: row.created_at,
});

export const User = {
  async create(input: CreateUserInput): Promise<IUser> {
    assertRole(input.role);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role, name, is_guest, tedix_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
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
      clauses.push(`role = $${values.length}`);
    }

    if (clauses.length === 0) return null;

    const { rows } = await pool.query(
      `SELECT * FROM users WHERE ${clauses.join(' AND ')} LIMIT 1`,
      values,
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async findById(id: string): Promise<IUser | null> {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  },
};
