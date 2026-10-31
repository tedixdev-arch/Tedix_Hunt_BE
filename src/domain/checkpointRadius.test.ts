import { describe, expect, it } from 'vitest';
import { validRadius, validRadiusPatch } from './checkpointRadius.js';
describe('radius numeric transport and compatibility envelope', () => {
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite radius %s without coercion', radiusMeters => {
    expect(validRadius(radiusMeters)).toBe(false);
    expect(validRadiusPatch({ checkpointPositions: [{ checkpointNumber: 1, radiusMeters }] })).toBe(false);
  });
});
