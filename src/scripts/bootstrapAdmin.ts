import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import { pool } from '../lib/postgres.js';
import { normalizeEmail } from '../models/User.js';

const BOOTSTRAP_LOCK_ID = 2_026_090_601;

export interface BootstrapAdminInput {
  email: string;
  password: string;
  name?: string;
  allowAdditionalAdmin?: boolean;
}

export interface BootstrapAdminResult {
  email: string;
  userId: string;
}

export class BootstrapAdminError extends Error {}

type BootstrapPool = Pick<Pool, 'connect'>;

export const validateBootstrapInput = (input: BootstrapAdminInput): BootstrapAdminInput => {
  if (typeof input.email !== 'string' || !input.email.trim()) {
    throw new BootstrapAdminError('--email is required and must be non-empty.');
  }
  if (typeof input.password !== 'string' || !input.password) {
    throw new BootstrapAdminError(
      'A password is required. Provide --password or set TEDIX_BOOTSTRAP_ADMIN_PASSWORD.',
    );
  }
  if (input.password.length < 8) {
    throw new BootstrapAdminError('The Admin password must be at least 8 characters.');
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) {
    throw new BootstrapAdminError('--name must be non-empty when supplied.');
  }
  return {
    ...input,
    email: normalizeEmail(input.email),
    name: input.name?.trim(),
  };
};

export const bootstrapAdmin = async (
  rawInput: BootstrapAdminInput,
  database: BootstrapPool = pool,
): Promise<BootstrapAdminResult> => {
  const input = validateBootstrapInput(rawInput);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Serialize the safety check and assignment so two operators cannot both bootstrap a first Admin.
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_ID]);
    const admin = await client.query("SELECT 1 FROM user_roles WHERE role = 'admin' LIMIT 1");
    if (admin.rows[0] && !input.allowAdditionalAdmin) {
      throw new BootstrapAdminError(
        'An Admin already exists. Use the normal Admin-managed provisioning flow, or rerun with --allow-additional-admin if this is an intentional recovery/maintenance operation.',
      );
    }

    const existing = await client.query(
      'SELECT id, password_hash FROM users WHERE email = $1 LIMIT 1 FOR UPDATE',
      [input.email],
    );
    let userId: string;
    if (existing.rows[0]) {
      if (!existing.rows[0].password_hash) {
        throw new BootstrapAdminError(
          'The existing user has no password. Admin bootstrap will not set or reset existing credentials.',
        );
      }
      userId = existing.rows[0].id;
    } else {
      const passwordHash = await bcrypt.hash(input.password, 12);
      // `creator` satisfies the legacy column for a non-guest professional account only. It grants
      // no capability: user_roles remains authoritative and receives only `admin` below.
      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, role, name, is_guest)
         VALUES ($1, $2, 'creator', $3, FALSE) RETURNING id`,
        [input.email, passwordHash, input.name ?? null],
      );
      userId = inserted.rows[0].id;
    }

    // Idempotence preserves every other authoritative role already attached to this identity.
    await client.query(
      `INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')
       ON CONFLICT (user_id, role) DO NOTHING`,
      [userId],
    );
    await client.query('COMMIT');
    return { email: input.email, userId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const parseBootstrapArguments = (
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): BootstrapAdminInput => {
  const parsed: Partial<BootstrapAdminInput> = {};
  let explicitPassword = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--allow-additional-admin') {
      parsed.allowAdditionalAdmin = true;
      continue;
    }
    if (argument !== '--email' && argument !== '--password' && argument !== '--name') {
      // Do not echo unknown values: a misplaced password must never appear in CLI errors.
      throw new BootstrapAdminError('Unknown argument provided.');
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new BootstrapAdminError(`${argument} requires a value.`);
    }
    if (argument === '--email') parsed.email = value;
    if (argument === '--password') {
      parsed.password = value;
      explicitPassword = true;
    }
    if (argument === '--name') parsed.name = value;
    index += 1;
  }
  // Command-line input wins for development/tests; server operators should prefer the environment.
  if (!explicitPassword) parsed.password = environment.TEDIX_BOOTSTRAP_ADMIN_PASSWORD;
  return validateBootstrapInput(parsed as BootstrapAdminInput);
};

const run = async (): Promise<void> => {
  try {
    const result = await bootstrapAdmin(parseBootstrapArguments(process.argv.slice(2)));
    console.log('Admin bootstrap successful');
    console.log(`User: ${result.email}`);
    console.log(`User ID: ${result.userId}`);
    console.log('Admin role: assigned');
  } catch (error) {
    const message = error instanceof BootstrapAdminError
      ? error.message
      : 'Admin bootstrap failed due to a database or internal error.';
    console.error(message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void run();
}
