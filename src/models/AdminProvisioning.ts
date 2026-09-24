import crypto from 'node:crypto';
import { pool } from '../lib/postgres.js';
import { normalizeEmail, type IUser } from './User.js';

const ACTIVATION_LIFETIME_MS = 24 * 60 * 60 * 1000;

const mapUser = (row: any): IUser => ({
  id: row.id, email: row.email, passwordHash: row.password_hash, role: row.role,
  roles: row.roles ?? [], name: row.name, isGuest: row.is_guest,
  tedixUserId: row.tedix_user_id, createdAt: row.created_at,
  accountStatus: row.account_status ?? 'active',
});

export type AdminActivationState = 'not_required' | 'pending' | 'expired';
export interface ListedAdmin extends IUser { activationState: AdminActivationState }
export class GuestPromotionError extends Error {}
export class ActivationAlreadyPendingError extends Error {}

export const AdminProvisioning = {
  async list(): Promise<ListedAdmin[]> {
    const { rows } = await pool.query(`
      SELECT users.*,
        ARRAY(SELECT role FROM user_roles WHERE user_id = users.id ORDER BY role) roles,
        CASE
          WHEN users.password_hash IS NOT NULL THEN 'not_required'
          WHEN EXISTS (SELECT 1 FROM professional_activation_tokens pat
            WHERE pat.user_id = users.id AND pat.purpose = 'admin_activation'
              AND pat.consumed_at IS NULL AND pat.expires_at > now()) THEN 'pending'
          ELSE 'expired'
        END activation_state
      FROM users
      WHERE EXISTS (SELECT 1 FROM user_roles WHERE user_id = users.id AND role = 'admin')
      ORDER BY users.created_at ASC`);
    return rows.map((row) => ({ ...mapUser(row), activationState: row.activation_state }));
  },

  async provision(emailInput: string, name: string | undefined, createdBy: string): Promise<{
    user: IUser; activationRequired: boolean; activationToken?: string; activationExpiresAt?: Date;
  }> {
    const email = normalizeEmail(emailInput);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A transaction-scoped key makes lookup/create deterministic for the same normalized email.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
      let row = (await client.query('SELECT * FROM users WHERE email = $1 FOR UPDATE', [email])).rows[0];
      if (row?.is_guest) throw new GuestPromotionError();
      if (!row) {
        row = (await client.query(
          `INSERT INTO users (email, name, role, is_guest, password_hash)
           VALUES ($1, $2, 'participant', FALSE, NULL) RETURNING *`,
          [email, name?.trim() || null],
        )).rows[0];
      }
      await client.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
        [row.id],
      );

      let activationToken: string | undefined;
      let activationExpiresAt: Date | undefined;
      if (row.password_hash === null) {
        // Expired credentials are retired before issuing a replacement. A still-valid credential
        // is never rotated implicitly because its plaintext can only be returned once.
        await client.query(
          `UPDATE professional_activation_tokens SET consumed_at = now()
           WHERE user_id = $1 AND purpose = 'admin_activation' AND consumed_at IS NULL
             AND expires_at <= now()`, [row.id],
        );
        const pending = await client.query(
          `SELECT 1 FROM professional_activation_tokens
           WHERE user_id = $1 AND purpose = 'admin_activation' AND consumed_at IS NULL
             AND expires_at > now()`, [row.id],
        );
        if (pending.rows[0]) throw new ActivationAlreadyPendingError();
        activationToken = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(activationToken).digest('hex');
        activationExpiresAt = new Date(Date.now() + ACTIVATION_LIFETIME_MS);
        await client.query(
          `INSERT INTO professional_activation_tokens
             (user_id, token_hash, purpose, expires_at, created_by)
           VALUES ($1, $2, 'admin_activation', $3, $4)`,
          [row.id, tokenHash, activationExpiresAt, createdBy],
        );
      }
      const hydrated = (await client.query(
        `SELECT users.*, ARRAY(SELECT role FROM user_roles WHERE user_id = users.id ORDER BY role) roles
         FROM users WHERE id = $1`, [row.id],
      )).rows[0];
      await client.query('COMMIT');
      return {
        user: mapUser(hydrated), activationRequired: Boolean(activationToken),
        ...(activationToken ? { activationToken, activationExpiresAt } : {}),
      };
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
      const token = (await client.query(
        `UPDATE professional_activation_tokens SET consumed_at = now()
         WHERE token_hash = $1 AND purpose = 'admin_activation' AND consumed_at IS NULL
           AND expires_at > now()
         RETURNING user_id`, [tokenHash],
      )).rows[0];
      if (!token) {
        await client.query('ROLLBACK');
        return null;
      }
      // A token can only establish credentials once; it can never replace a password.
      const changed = await client.query(
        'UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash IS NULL RETURNING *',
        [token.user_id, passwordHash],
      );
      if (!changed.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(
        `INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
        [token.user_id],
      );
      const row = (await client.query(
        `SELECT users.*, ARRAY(SELECT role FROM user_roles WHERE user_id = users.id ORDER BY role) roles
         FROM users WHERE id = $1`, [token.user_id],
      )).rows[0];
      await client.query('COMMIT');
      return mapUser(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
};
