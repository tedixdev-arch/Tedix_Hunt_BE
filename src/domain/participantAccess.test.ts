import { describe, expect, it } from 'vitest';
import { distanceMeters, evaluateProximity, snapshotCheckpoints, validObservation } from './participantAccess.js';
import { signalClujNapocaV1 } from './templates/signalClujNapocaV1.js';
import { createSignalClujNapocaStarter } from './templates/signalClujNapocaStarter.js';

const now = Date.parse('2026-10-31T20:00:00.000Z');
const observation = { latitude: 0, longitude: 0, accuracyMeters: 1, observedAt: new Date(now).toISOString() };
const point = { latitude: 0, longitude: 0, radiusMeters: 5 };
// Hypothetical review values only; these do not approve/enable runtime policy.
const policy = { maxAgeMs: 30_000, maxAccuracyMeters: 5, uncertainty: 'contained' as const };
describe('Participant proximity calculations (not GPS trust or runtime policy approval)', () => {
  it('uses Haversine, handles poles, antimeridian and antipodes', () => {
    expect(distanceMeters(point, point)).toBe(0);
    expect(distanceMeters(point, { latitude: 0, longitude: 1 })).toBeCloseTo(111195.08, 2);
    expect(distanceMeters({ latitude: 0, longitude: 179.999 }, { latitude: 0, longitude: -179.999 })).toBeCloseTo(222.39, 2);
    expect(Number.isFinite(distanceMeters({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 180 }))).toBe(true);
  });
  it('tests radius boundaries and both proposed uncertainty alternatives without approving either', () => {
    const d = distanceMeters(point, { latitude: 0, longitude: 0.00004 });
    const obs = { ...observation, longitude: 0.00004, accuracyMeters: 0 };
    expect(evaluateProximity(obs, { ...point, radiusMeters: d }, policy, now)).toBe('verified');
    expect(evaluateProximity(obs, { ...point, radiusMeters: d - 0.000001 }, policy, now)).toBe('outside_radius');
    expect(evaluateProximity({ ...obs, accuracyMeters: 1 }, point, policy, now)).toBe('outside_radius');
    expect(evaluateProximity({ ...obs, accuracyMeters: 1 }, point, { ...policy, uncertainty: 'center' }, now)).toBe('verified');
    expect(evaluateProximity({ ...obs, longitude: 0.0001 }, { ...point, radiusMeters: 20 }, policy, now)).toBe('verified');
  });
  it('fails invalid, future, stale and inaccurate observations under explicit hypothetical policy', () => {
    expect(evaluateProximity(observation, point, policy, now + 30_000)).toBe('verified');
    expect(evaluateProximity(observation, point, policy, now + 30_001)).toBe('stale');
    expect(evaluateProximity(observation, point, policy, now - 1)).toBe('stale');
    expect(evaluateProximity({ ...observation, accuracyMeters: 5.01 }, point, policy, now)).toBe('inaccurate');
    for (const latitude of [NaN, Infinity, -Infinity, 91, -91, '0', null]) expect(validObservation({ ...observation, latitude })).toBe(false);
    for (const observedAt of ['2026-02-30T00:00:00.000Z', 'now', '2026-10-31', '2026-10-31T20:00:00Z']) expect(validObservation({ ...observation, observedAt })).toBe(false);
    expect(validObservation({ ...observation, completed: true })).toBe(false);
    expect(evaluateProximity(observation, { ...point, radiusMeters: NaN }, policy, now)).toBe('invalid_observation');
  });
  it('keeps original Signal six checkpoints and playable FinishPoint without inventing GPS', () => {
    const before = JSON.stringify(signalClujNapocaV1);
    const legacy = snapshotCheckpoints(signalClujNapocaV1, 'signal-cluj-napoca', 1);
    expect(legacy.map(c => c.kind)).toEqual([...Array(6).fill('regular'), 'finish']);
    expect(legacy.every(c => c.point === null)).toBe(true);
    const starter = createSignalClujNapocaStarter('test-route');
    expect(snapshotCheckpoints(starter, 'test-route', 1).map(c => c.kind)).toEqual(legacy.map(c => c.kind));
    expect(JSON.stringify(signalClujNapocaV1)).toBe(before);
  });
  it('rejects version mismatch and ambiguous order or terminal identity', () => {
    expect(() => snapshotCheckpoints(signalClujNapocaV1, 'signal-cluj-napoca', 2)).toThrow();
    const starter = createSignalClujNapocaStarter('test-route');
    expect(() => snapshotCheckpoints({ ...starter, checkpoints: [...starter.checkpoints].reverse() }, 'test-route', 1)).toThrow();
    expect(() => snapshotCheckpoints({ ...starter, checkpoints: starter.checkpoints.slice(0, 6) }, 'test-route', 1)).toThrow();
  });
});
