import { describe, expect, it } from 'vitest';
import {
  generateHuntAccessCode, HUNT_ACCESS_ALPHABET, normalizeHuntAccessCode,
} from './huntAccess.js';

describe('Hunt access codes', () => {
  it('securely generates eight characters from the non-ambiguous alphabet', () => {
    for (let index = 0; index < 100; index += 1) {
      const code = generateHuntAccessCode();
      expect(code).toHaveLength(8);
      expect([...code].every((character) => HUNT_ACCESS_ALPHABET.includes(character))).toBe(true);
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  it('normalizes valid input and rejects malformed input', () => {
    expect(normalizeHuntAccessCode(' 7kpm4xq2 ')).toBe('7KPM4XQ2');
    expect(normalizeHuntAccessCode('SIGNAL26')).toBeNull();
    expect(normalizeHuntAccessCode('7KPM4XQ0')).toBeNull();
  });
});
