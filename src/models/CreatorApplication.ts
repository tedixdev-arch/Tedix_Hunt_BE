import { pool } from '../lib/postgres.js';
import { normalizeEmail } from './User.js';

export type CreatorApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface CreatorApplication {
  id: string;
  userId: string;
  name: string;
  email: string;
  status: CreatorApplicationStatus;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
}

export interface CreateCreatorApplicationInput {
  name: string;
  email: string;
  passwordHash: string;
}

const mapRow = (row: any): CreatorApplication => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  email: row.email,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  reviewedAt: row.reviewed_at,
  reviewedBy: row.reviewed_by,
});

export class CreatorApplicationNotPendingError extends Error {}
export class CreatorApplicationIdentityConflictError extends Error {}

export const CreatorApplications = {
  async create(input: CreateCreatorApplicationInput): Promise<CreatorApplication> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const email = normalizeEmail(input.email);
      // Serialize identity reuse so normalized email can never produce duplicate users.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
      let user = (await client.query(
        `SELECT users.*, EXISTS (
           SELECT 1 FROM user_roles WHERE user_id = users.id AND role = 'creator'
         ) AS is_creator
         FROM users WHERE email = $1 FOR UPDATE`, [email],
      )).rows[0];
      if (user && (user.is_guest || user.account_status !== 'active' || user.is_creator)) {
        throw new CreatorApplicationIdentityConflictError();
      }
      if (!user) {
        // The legacy role is compatibility metadata; user_roles remains authoritative.
        user = (await client.query(
          `INSERT INTO users (email, name, role, is_guest, password_hash)
           VALUES ($1, $2, 'creator', FALSE, $3) RETURNING *`,
          [email, input.name, input.passwordHash],
        )).rows[0];
      } else if (user.password_hash === null) {
        await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, input.passwordHash]);
      }
      // An established credential is deliberately preserved; applying is never a password reset.
      const { rows } = await client.query(
        `INSERT INTO creator_applications (user_id, name, email)
         VALUES ($1, $2, $3) RETURNING *`,
        [user.id, input.name, email],
      );
      await client.query('COMMIT');
      return mapRow(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') {
        throw new CreatorApplicationIdentityConflictError();
      }
      throw error;
    } finally { client.release(); }
  },

  async findById(id: string): Promise<CreatorApplication | null> {
    const { rows } = await pool.query('SELECT * FROM creator_applications WHERE id = $1', [id]);
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async list(status?: CreatorApplicationStatus): Promise<CreatorApplication[]> {
    const { rows } = await pool.query(
      `SELECT * FROM creator_applications
       ${status ? 'WHERE status = $1' : ''} ORDER BY created_at DESC`, status ? [status] : [],
    );
    return rows.map(mapRow);
  },

  async approve(id: string, adminId: string): Promise<CreatorApplication | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const application = (await client.query(
        'SELECT * FROM creator_applications WHERE id = $1 FOR UPDATE', [id],
      )).rows[0];
      if (!application) { await client.query('ROLLBACK'); return null; }
      if (application.status !== 'pending') throw new CreatorApplicationNotPendingError();
      const identity = (await client.query(
        'SELECT account_status, is_guest FROM users WHERE id = $1 FOR UPDATE', [application.user_id],
      )).rows[0];
      if (!identity || identity.is_guest || identity.account_status !== 'active') {
        throw new CreatorApplicationIdentityConflictError();
      }
      // Approval grants only Creator authorization. It never establishes credentials or activation tokens.
      await client.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, 'creator') ON CONFLICT DO NOTHING`,
        [application.user_id],
      );
      const { rows } = await client.query(
        `UPDATE creator_applications SET status = 'approved', reviewed_at = now(),
         reviewed_by = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, adminId],
      );
      await client.query('COMMIT');
      return mapRow(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  },

  async reject(id: string, adminId: string): Promise<CreatorApplication | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const application = (await client.query(
        'SELECT status FROM creator_applications WHERE id = $1 FOR UPDATE', [id],
      )).rows[0];
      if (!application) { await client.query('ROLLBACK'); return null; }
      if (application.status !== 'pending') throw new CreatorApplicationNotPendingError();
      const { rows } = await client.query(
        `UPDATE creator_applications SET status = 'rejected', reviewed_at = now(),
         reviewed_by = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, adminId],
      );
      await client.query('COMMIT');
      return mapRow(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  },
};
