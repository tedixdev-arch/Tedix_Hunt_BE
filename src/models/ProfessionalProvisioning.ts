import crypto from 'node:crypto';
import { pool } from '../lib/postgres.js';
import { normalizeEmail, type IUser } from './User.js';

const ACTIVATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
export type ProfessionalRole = 'organizer' | 'creator';
export type ProfessionalActivationState = 'not_required' | 'pending' | 'expired';
export interface ListedProfessional extends IUser { activationState: ProfessionalActivationState }
export interface ProvisionedOrganization { id: string; name: string }

export class ProfessionalGuestPromotionError extends Error {}
export class ProfessionalActivationAlreadyPendingError extends Error {
  constructor(readonly role: ProfessionalRole) { super(`${role}_activation_already_pending`); }
}

const mapUser = (row: any): IUser => ({
  id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role,
  roles: row.roles ?? [], name: row.name, isGuest: row.is_guest,
  tedixUserId: row.tedix_user_id, createdAt: row.created_at,
  accountStatus: row.account_status ?? 'active',
});

const purposeFor = (role: ProfessionalRole) => `${role}_activation`;

export const ProfessionalProvisioning = {
  async list(role: ProfessionalRole): Promise<ListedProfessional[]> {
    const purpose = purposeFor(role);
    const { rows } = await pool.query(`
      SELECT users.*,
        ARRAY(SELECT role FROM user_roles WHERE user_id = users.id ORDER BY role) roles,
        CASE
          WHEN users.password_hash IS NOT NULL THEN 'not_required'
          WHEN EXISTS (SELECT 1 FROM professional_activation_tokens pat
            WHERE pat.user_id = users.id AND pat.purpose = $2
              AND pat.consumed_at IS NULL AND pat.expires_at > now()) THEN 'pending'
          ELSE 'expired'
        END activation_state
      FROM users
      WHERE EXISTS (SELECT 1 FROM user_roles WHERE user_id = users.id AND role = $1)
      ORDER BY users.created_at ASC`, [role, purpose]);
    return rows.map((row) => ({ ...mapUser(row), activationState: row.activation_state }));
  },

  async provision(input: {
    email: string; name?: string; role: ProfessionalRole; createdBy: string;
    organizationName?: string;
  }): Promise<{
    user: IUser; role: ProfessionalRole; organization?: ProvisionedOrganization;
    activationRequired: boolean; activationToken?: string; activationExpiresAt?: Date;
  }> {
    const email = normalizeEmail(input.email);
    if (!email || (input.role === 'organizer' && !input.organizationName?.trim())) {
      throw new Error('invalid_professional_provisioning_input');
    }
    const purpose = purposeFor(input.role);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
      let row = (await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email])).rows[0];
      if (row?.is_guest) throw new ProfessionalGuestPromotionError();
      if (!row) {
        // users.role is compatibility data only; user_roles below grants the capability.
        row = (await client.query(
          `INSERT INTO users (email, name, role, is_guest, password_hash)
           VALUES ($1, $2, 'participant', FALSE, NULL) RETURNING *`,
          [email, input.name?.trim() || null],
        )).rows[0];
      }
      await client.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [row.id, input.role],
      );

      let activationToken: string | undefined;
      let activationExpiresAt: Date | undefined;
      if (row.password_hash === null) {
        await client.query(
          `UPDATE professional_activation_tokens SET consumed_at = now()
           WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at <= now()`,
          [row.id, purpose],
        );
        const pending = await client.query(
          `SELECT 1 FROM professional_activation_tokens
           WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()`,
          [row.id, purpose],
        );
        if (pending.rows[0]) throw new ProfessionalActivationAlreadyPendingError(input.role);
        activationToken = crypto.randomBytes(32).toString('base64url');
        activationExpiresAt = new Date(Date.now() + ACTIVATION_LIFETIME_MS);
        const digest = crypto.createHash('sha256').update(activationToken).digest('hex');
        await client.query(
          `INSERT INTO professional_activation_tokens
             (user_id, token_hash, purpose, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, digest, purpose, activationExpiresAt, input.createdBy],
        );
      }

      let organization: ProvisionedOrganization | undefined;
      if (input.role === 'organizer') {
        const organizationName = input.organizationName!.trim();
        // The email advisory lock also serializes organization lookup/create for this owner.
        // Reuse only an organization owned by this identity with the same normalized name.
        let org = (await client.query(
          `SELECT id, name FROM organizations
           WHERE owner_id = $1 AND lower(btrim(name)) = lower(btrim($2))
           ORDER BY created_at ASC LIMIT 1`,
          [row.id, organizationName],
        )).rows[0];
        if (!org) {
          org = (await client.query(
            `INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id, name`,
            [organizationName, row.id],
          )).rows[0];
        }
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [org.id, row.id],
        );
        organization = { id: org.id, name: org.name };
      }

      const hydrated = (await client.query(
        `SELECT users.*, ARRAY(SELECT role FROM user_roles WHERE user_id = users.id ORDER BY role) roles
         FROM users WHERE id = $1`, [row.id],
      )).rows[0];
      await client.query('COMMIT');
      return {
        user: mapUser(hydrated), role: input.role, activationRequired: Boolean(activationToken),
        ...(organization ? { organization } : {}),
        ...(activationToken ? { activationToken, activationExpiresAt } : {}),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  },

  async activate(role: ProfessionalRole, tokenHash: string, passwordHash: string): Promise<IUser | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const token = (await client.query(
        `UPDATE professional_activation_tokens SET consumed_at = now()
         WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
         RETURNING user_id`, [tokenHash, purposeFor(role)],
      )).rows[0];
      if (!token) { await client.query('ROLLBACK'); return null; }
      const changed = await client.query(
        `UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash IS NULL RETURNING *`,
        [token.user_id, passwordHash],
      );
      if (!changed.rows[0]) { await client.query('ROLLBACK'); return null; }
      await client.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [token.user_id, role],
      );
      const row = (await client.query(
        `SELECT users.*, ARRAY(SELECT role FROM user_roles WHERE user_id = users.id ORDER BY role) roles
         FROM users WHERE id = $1`, [token.user_id],
      )).rows[0];
      await client.query('COMMIT');
      return mapUser(row);
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  },
};
