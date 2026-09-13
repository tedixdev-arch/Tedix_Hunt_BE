import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP scrypt profile: N=2^15, r=8, p=3. Explicit limits also bound verification.
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error); else resolve(key);
  });
});

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$32768$8$3$${salt}$${key.toString('hex')}`;
};

export const verifyPassword = async (password: string, encoded: string | null): Promise<boolean> => {
  const match = encoded?.match(/^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/);
  // Perform the same expensive operation for unknown users/passwordless identities.
  const key = await derive(password, match?.[1] ?? '0'.repeat(32));
  return !!match && timingSafeEqual(key, Buffer.from(match[2], 'hex'));
};
