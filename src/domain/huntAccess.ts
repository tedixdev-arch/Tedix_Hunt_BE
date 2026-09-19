import { randomInt } from 'node:crypto';

export const HUNT_ACCESS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const HUNT_ACCESS_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export const generateHuntAccessCode = (): string => Array.from(
  { length: 8 },
  () => HUNT_ACCESS_ALPHABET[randomInt(HUNT_ACCESS_ALPHABET.length)],
).join('');

export const normalizeHuntAccessCode = (value: string): string | null => {
  const code = value.trim().toUpperCase();
  return HUNT_ACCESS_CODE_PATTERN.test(code) ? code : null;
};
