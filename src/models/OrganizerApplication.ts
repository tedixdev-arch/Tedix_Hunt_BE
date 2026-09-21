import crypto from 'node:crypto';
import { pool } from '../lib/postgres.js';
import { normalizeEmail, type IUser } from './User.js';

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
  activationExpiresAt: Date | null;
  activatedAt: Date | null;
}

export interface CreateOrganizerApplicationInput {
  name: string;
  email: string;
  organizationName: string;
  organizationType: OrganizationType;
  reason: string;
  phone: string | null;
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
  activationExpiresAt: row.activation_expires_at,
  activatedAt: row.activated_at,
});

export class ApplicationNotPendingError extends Error {}

export const OrganizerApplications = {
  async create(input: CreateOrganizerApplicationInput): Promise<OrganizerApplication> {
    const { rows } = await pool.query(
      `INSERT INTO organizer_applications
         (name, email, organization_name, organization_type, reason, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.name, input.email, input.organizationName, input.organizationType, input.reason, input.phone],
    );
    return mapRow(rows[0]);
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

  async approve(id: string, adminId: string): Promise<{
    application: OrganizerApplication; activationToken: string;
  } | null> {
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
      let user = (await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email])).rows[0];
      if (!user) {
        // users.role is compatibility data only; no capability exists until user_roles is written.
        user = (await client.query(
          `INSERT INTO users (email, name, role, is_guest, password_hash)
           VALUES ($1, $2, 'organizer', FALSE, NULL) RETURNING id`,
          [email, application.name],
        )).rows[0];
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

      const activationToken = crypto.randomBytes(32).toString('base64url');
      // Only the digest crosses the persistence boundary; plaintext is returned once.
      const tokenHash = crypto.createHash('sha256').update(activationToken).digest('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const { rows } = await client.query(
        `UPDATE organizer_applications SET status = 'approved', reviewed_at = now(),
           reviewed_by = $2, user_id = $3, organization_id = $4,
           activation_token_hash = $5, activation_expires_at = $6, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, adminId, user.id, organization.id, tokenHash, expiresAt],
      );
      await client.query('COMMIT');
      return { application: mapRow(rows[0]), activationToken };
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

  async activate(tokenHash: string, passwordHash: string): Promise<IUser | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Conditional update consumes a valid token exactly once, even under concurrent requests.
      const { rows } = await client.query(
        `UPDATE organizer_applications SET activated_at = now(), activation_token_hash = NULL,
           activation_expires_at = NULL, updated_at = now()
         WHERE activation_token_hash = $1 AND status = 'approved' AND activated_at IS NULL
           AND activation_expires_at > now() AND user_id IS NOT NULL
         RETURNING user_id`, [tokenHash],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [rows[0].user_id, passwordHash]);
      const userRows = await client.query(
        `SELECT users.*, ARRAY(SELECT role FROM user_roles WHERE user_id = users.id ORDER BY role) roles
         FROM users WHERE id = $1`, [rows[0].user_id],
      );
      await client.query('COMMIT');
      const row = userRows.rows[0];
      return {
        id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role,
        roles: row.roles, name: row.name, isGuest: row.is_guest,
        tedixUserId: row.tedix_user_id, createdAt: row.created_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};
