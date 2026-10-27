import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fresh = async () => {
  vi.resetModules();
  return import('./environment.js');
};

afterEach(() => vi.unstubAllEnvs());

describe('JWT signing configuration', () => {
  it.each(['production', 'development', 'staging', 'test', undefined])(
    'rejects an absent secret even in %s', async (mode) => {
      vi.stubEnv('NODE_ENV', mode);
      vi.stubEnv('JWT_SECRET', undefined);
      await expect(fresh()).rejects.toThrow('Invalid JWT_SECRET');
    },
  );

  it.each([
    '', '   ', 'change-me', 'CHANGE-ME', 'too-short',
    'change-me'.repeat(8), 'your-jwt-secret-goes-here-please-replace',
    'replace-with-a-secure-random-signing-key',
    'this-is-an-example-signing-key-for-documentation',
    'a'.repeat(64), '0123456789abcdef'.repeat(4),
    'unique-looking-but-test-only-signing-key',
    'super-secret-key-for-production-use',
    'abcdefghijklmnopqrstuvwxyz123456',
    'this-is-the-default-signing-value-for-now',
    randomBytes(16).toString('hex').slice(0, 31),
  ])('rejects unsafe input case %# without disclosing it', async (secret) => {
    vi.stubEnv('JWT_SECRET', secret);
    const error = await fresh().catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Invalid JWT_SECRET\./);
    if (secret.trim()) expect((error as Error).message).not.toContain(secret);
  });

  it('preserves a configured 32-byte random secret exactly', async () => {
    const secret = randomBytes(32).toString('base64');
    vi.stubEnv('JWT_SECRET', secret);
    const { environment, readEnvironment } = await fresh();
    expect(environment.jwtSecret).toBe(secret);
    expect(readEnvironment().jwtSecret).toBe(secret);
    vi.stubEnv('JWT_SECRET', undefined);
    expect(readEnvironment).toThrow('Invalid JWT_SECRET');
  });

  it('rejects surrounding whitespace instead of silently changing the key', async () => {
    vi.stubEnv('JWT_SECRET', ` ${randomBytes(32).toString('hex')} `);
    await expect(fresh()).rejects.toThrow('Invalid JWT_SECRET');
  });

  it('accepts the explicitly configured disposable test key without a mode bypass', async () => {
    const disposable = process.env.JWT_SECRET;
    expect(disposable).toBeTruthy();
    for (const mode of ['test', 'production']) {
      vi.stubEnv('NODE_ENV', mode);
      expect((await fresh()).environment.jwtSecret).toBe(disposable);
    }
  });
});

describe('application startup', () => {
  it.each([undefined, '', '   ', 'change-me', 'replace-with-a-secure-random-signing-key'])(
    'refuses invalid configuration before connecting or listening (case %#)', (secret) => {
      const cwd = mkdtempSync(join(tmpdir(), 'tedix-d07-'));
      try {
        const env = { ...process.env, NODE_ENV: 'production', JWT_SECRET: secret,
          DOTENV_CONFIG_PATH: join(cwd, 'absent.env'), DATABASE_URL: '',
          API_HOST: '127.0.0.1', API_PORT: '3001' };
        if (secret === undefined) delete env.JWT_SECRET;
        const result = spawnSync(process.execPath, [
          '--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)),
          fileURLToPath(new URL('../server.ts', import.meta.url)),
        ], { cwd, env, encoding: 'utf8', timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Invalid JWT_SECRET');
        expect(output).not.toMatch(/API listening|Connected to PostgreSQL|skipping PostgreSQL/);
        if (secret?.trim()) expect(output).not.toContain(secret);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
