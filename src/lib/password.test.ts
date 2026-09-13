import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('Password storage', () => {
  it('uses unique salts and verifies full passwords without truncation', async () => {
    const password = 'long password '.repeat(7);
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(password.slice(0, 72), first)).toBe(false);
  }, 10_000);
  it('rejects missing and malformed password hashes', async () => {
    expect(await verifyPassword('password', null)).toBe(false);
    expect(await verifyPassword('password', 'scrypt$9999999999$8$3$salt$hash')).toBe(false);
  });
});
