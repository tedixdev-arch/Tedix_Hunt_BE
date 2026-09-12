import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPostgresPool } from '../lib/postgres.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

export class AuthError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

interface UserRow { id: string; email: string; display_name: string | null }
const publicUser = (user: UserRow) => ({ id: user.id, email: user.email, displayName: user.display_name });
const randomToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const unauthorized = () => new AuthError(401, 'unauthorized', 'Authentication is required.');

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPostgresPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function newSession(client: PoolClient, user: UserRow) {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const { rows } = await client.query(
    `INSERT INTO auth_sessions (user_id, access_hash, access_expires_at, expires_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP + interval '15 minutes', CURRENT_TIMESTAMP + interval '7 days')
     RETURNING id, expires_at`, [user.id, tokenHash(accessToken)],
  );
  await client.query('INSERT INTO auth_refresh_tokens (token_hash, session_id) VALUES ($1, $2)', [tokenHash(refreshToken), rows[0].id]);
  return { user: publicUser(user), accessToken, refreshToken, expiresIn: 900, refreshExpiresAt: rows[0].expires_at as Date };
}

export const register = async (email: string, password: string, displayName: string | null) => {
  const passwordHash = await hashPassword(password);
  try {
    return await transaction(async (client) => {
      const { rows } = await client.query<UserRow>('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name', [email, passwordHash, displayName]);
      return newSession(client, rows[0]);
    });
  } catch (error) {
    if ((error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === 'users_email_unique') {
      throw new AuthError(409, 'email_unavailable', 'An account cannot be created with that email.');
    }
    throw error;
  }
};

export const login = async (email: string, password: string) => {
  const { rows } = await getPostgresPool().query<UserRow & { password_hash: string | null }>('SELECT id, email, display_name, password_hash FROM users WHERE lower(email) = $1', [email]);
  if (!await verifyPassword(password, rows[0]?.password_hash ?? null)) {
    throw new AuthError(401, 'invalid_credentials', 'Email or password is incorrect.');
  }
  return transaction((client) => newSession(client, rows[0]));
};

export const refresh = async (token: string) => {
  const result = await transaction(async (client) => {
    const { rows } = await client.query<UserRow & { session_id: string; used_at: Date | null; revoked_at: Date | null; expires_at: Date; active: boolean }>(
      `SELECT u.id, u.email, u.display_name, s.id AS session_id, t.used_at, s.revoked_at, s.expires_at,
       s.expires_at > CURRENT_TIMESTAMP AS active
       FROM auth_refresh_tokens t JOIN auth_sessions s ON s.id = t.session_id JOIN users u ON u.id = s.user_id
       WHERE t.token_hash = $1 FOR UPDATE OF s, t`, [tokenHash(token)],
    );
    const row = rows[0];
    if (!row || row.revoked_at || !row.active) return null;
    if (row.used_at) {
      // Commit revocation on replay; throwing inside the transaction would undo it.
      await client.query('UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1', [row.session_id]);
      return null;
    }
    const accessToken = randomToken();
    const refreshToken = randomToken();
    await client.query('UPDATE auth_refresh_tokens SET used_at = CURRENT_TIMESTAMP WHERE token_hash = $1', [tokenHash(token)]);
    await client.query("UPDATE auth_sessions SET access_hash = $1, access_expires_at = LEAST(CURRENT_TIMESTAMP + interval '15 minutes', expires_at) WHERE id = $2", [tokenHash(accessToken), row.session_id]);
    await client.query('INSERT INTO auth_refresh_tokens (token_hash, session_id) VALUES ($1, $2)', [tokenHash(refreshToken), row.session_id]);
    return { user: publicUser(row), accessToken, refreshToken, expiresIn: Math.min(900, Math.max(0, Math.floor((row.expires_at.getTime() - Date.now()) / 1000))), refreshExpiresAt: row.expires_at };
  });
  if (!result) throw unauthorized();
  return result;
};

export const currentUser = async (accessToken: string) => {
  const { rows } = await getPostgresPool().query<UserRow>(
    `SELECT u.id, u.email, u.display_name FROM users u JOIN auth_sessions s ON s.user_id = u.id
     WHERE s.access_hash = $1 AND s.revoked_at IS NULL AND s.access_expires_at > CURRENT_TIMESTAMP AND s.expires_at > CURRENT_TIMESTAMP`, [tokenHash(accessToken)],
  );
  if (!rows[0]) throw unauthorized();
  return publicUser(rows[0]);
};

export const logout = async (refreshToken?: string, accessToken?: string) => {
  await getPostgresPool().query(
    `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
     WHERE access_hash = $1 OR id IN (SELECT session_id FROM auth_refresh_tokens WHERE token_hash = $2)`,
    [accessToken ? tokenHash(accessToken) : null, refreshToken ? tokenHash(refreshToken) : null],
  );
};
