import { pool } from '../lib/postgres.js';
import { normalizeEmail } from './User.js';

export type OrganizationType = 'school' | 'ngo' | 'community' | 'other';
export type OrganizerApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface OrganizerApplication {
  id: string;
  name: string;
  email: string;
  organizationName: string;
  organizationType: OrganizationType;
  reason: string;
  phone: string | null;
  status: OrganizerApplicationStatus;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  userId: string | null;
  organizationId: string | null;
}

export interface CreateOrganizerApplicationInput {
  name: string;
  email: string;
  organizationName: string;
  organizationType: OrganizationType;
  reason: string;
  phone: string | null;
  passwordHash: string;
}

const mapRow = (row: any): OrganizerApplication => ({
  id: row.id,
  name: row.name,
  email: row.email,
  organizationName: row.organization_name,
  organizationType: row.organization_type,
  reason: row.reason,
  phone: row.phone,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  reviewedAt: row.reviewed_at,
  reviewedBy: row.reviewed_by,
  userId: row.user_id,
  organizationId: row.organization_id,
});

export class ApplicationNotPendingError extends Error {}

export const OrganizerApplications = {
  async create(input: CreateOrganizerApplicationInput): Promise<OrganizerApplication> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const email = normalizeEmail(input.email);
      // Serialize registration for an email so concurrent requests cannot create two identities.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
      let user = (await client.query(
        'SELECT id, password_hash FROM users WHERE email = $1 FOR UPDATE', [email],
      )).rows[0];
      if (!user) {
        // Legacy role is compatibility metadata; user_roles remains the access authority.
        user = (await client.query(
          `INSERT INTO users (email, name, role, is_guest, password_hash)
           VALUES ($1, $2, 'organizer', FALSE, $3) RETURNING id, password_hash`,
          [email, input.name, input.passwordHash],
        )).rows[0];
      } else if (user.password_hash === null) {
        await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, input.passwordHash]);
      }
      // A password-backed identity keeps its established credential; application input never resets it.
      const { rows } = await client.query(
        `INSERT INTO organizer_applications
           (name, email, organization_name, organization_type, reason, phone, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [input.name, email, input.organizationName, input.organizationType, input.reason, input.phone, user.id],
      );
      await client.query('COMMIT');
      return mapRow(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async findById(id: string): Promise<OrganizerApplication | null> {
    const { rows } = await pool.query(
      'SELECT * FROM organizer_applications WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  },

  async list(status?: OrganizerApplicationStatus): Promise<OrganizerApplication[]> {
    const { rows } = await pool.query(
      `SELECT * FROM organizer_applications
       ${status ? 'WHERE status = $1' : ''} ORDER BY created_at DESC`,
      status ? [status] : [],
    );
    return rows.map(mapRow);
  },

  async approve(id: string, adminId: string): Promise<OrganizerApplication | null> {
    const client = await pool.connect();
    try {
      // Provisioning is one transaction; the row lock serializes competing decisions.
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT * FROM organizer_applications WHERE id = $1 FOR UPDATE', [id],
      );
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const application = locked.rows[0];
      if (application.status !== 'pending') throw new ApplicationNotPendingError();

      const email = normalizeEmail(application.email);
      let user = (await client.query(
        'SELECT id FROM users WHERE id = $1 AND email = $2 FOR UPDATE', [application.user_id, email],
      )).rows[0];
      if (!user) {
        throw new Error('application_identity_missing');
      }

      // user_roles is the authoritative organizer capability.
      await client.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, 'organizer')
         ON CONFLICT DO NOTHING`, [user.id],
      );
      const organization = (await client.query(
        'INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id',
        [application.organization_name, user.id],
      )).rows[0];
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`, [organization.id, user.id],
      );

      const { rows } = await client.query(
        `UPDATE organizer_applications SET status = 'approved', reviewed_at = now(),
           reviewed_by = $2, organization_id = $3, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, adminId, organization.id],
      );
      await client.query('COMMIT');
      return mapRow(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },

  async reject(id: string, adminId: string): Promise<OrganizerApplication | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        'SELECT status FROM organizer_applications WHERE id = $1 FOR UPDATE', [id],
      );
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      if (locked.rows[0].status !== 'pending') throw new ApplicationNotPendingError();
      const { rows } = await client.query(
        `UPDATE organizer_applications SET status = 'rejected', reviewed_at = now(),
         reviewed_by = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, adminId],
      );
      await client.query('COMMIT');
      return mapRow(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};
