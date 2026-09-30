import { describe, expect, it } from 'vitest';
import {
  isTemplateContent,
  isTemplateContentSubmittable,
} from './creatorTemplates.js';

const position = (checkpointNumber: number) => ({
  checkpointNumber,
  name: `Checkpoint ${checkpointNumber}`,
  latitude: 46.7712 + checkpointNumber / 1000,
  longitude: 23.6236 + checkpointNumber / 1000,
  radiusMeters: 25,
});

const content = (configuration: Record<string, unknown>) => ({
  key: 'geo-trail', version: 1, displayName: 'Geo Trail', theme: 'Navigation',
  mission: { name: 'Go' }, configuration, scoring: { startingScore: 100 },
  checkpoints: [{ id: 'one' }],
});

describe('Creator Template geographic content', () => {
  it.each([1, 6, 20])('accepts normal checkpoint count %i in a progressive draft', (count) => {
    expect(isTemplateContent(content({ normalCheckpointCount: count }), 'geo-trail', 1)).toBe(true);
  });

  it.each([0, 21, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid normal checkpoint count %s',
    (count) => expect(isTemplateContent(
      content({ normalCheckpointCount: count }), 'geo-trail', 1,
    )).toBe(false),
  );

  it('accepts boundary coordinates and an unordered complete normal-checkpoint set', () => {
    const positions = [
      { ...position(2), latitude: 90, longitude: 180, radiusMeters: 500 },
      { ...position(1), latitude: -90, longitude: -180, radiusMeters: 10 },
    ];
    const value = content({ normalCheckpointCount: 2, checkpointPositions: positions });
    expect(isTemplateContent(value, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(value)).toBe(true);
  });

  it.each([
    ['latitude above range', { latitude: 91 }],
    ['latitude below range', { latitude: -91 }],
    ['longitude above range', { longitude: 181 }],
    ['longitude below range', { longitude: -181 }],
    ['non-finite latitude', { latitude: Number.POSITIVE_INFINITY }],
    ['non-finite longitude', { longitude: Number.NaN }],
  ])('rejects %s', (_case, override) => {
    expect(isTemplateContent(content({
      normalCheckpointCount: 1,
      checkpointPositions: [{ ...position(1), ...override }],
    }), 'geo-trail', 1)).toBe(false);
  });

  it.each([
    ['duplicate numbers', [position(1), position(1)]],
    ['zero', [position(0)]],
    ['FinishPoint as N + 1', [position(1), position(2), position(3)]],
    ['fractional number', [{ ...position(1), checkpointNumber: 1.5 }]],
  ])('rejects %s', (_case, checkpointPositions) => {
    expect(isTemplateContent(content({
      normalCheckpointCount: 2, checkpointPositions,
    }), 'geo-trail', 1)).toBe(false);
  });

  it.each([0, 9, 501, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects radius %s metres',
    (radiusMeters) => expect(isTemplateContent(content({
      normalCheckpointCount: 1,
      checkpointPositions: [{ ...position(1), radiusMeters }],
    }), 'geo-trail', 1)).toBe(false),
  );

  it('allows incomplete positions in a draft but not at submission', () => {
    const draft = content({ normalCheckpointCount: 3, checkpointPositions: [position(1)] });
    expect(isTemplateContent(draft, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(draft)).toBe(false);
  });

  it('requires position names and all geographic fields', () => {
    const missingLongitude = { ...position(1) } as Partial<ReturnType<typeof position>>;
    delete missingLongitude.longitude;
    for (const invalid of [
      { ...position(1), name: '   ' },
      { ...position(1), name: 'x'.repeat(101) },
      missingLongitude,
    ]) {
      expect(isTemplateContent(content({
        normalCheckpointCount: 1, checkpointPositions: [invalid],
      }), 'geo-trail', 1)).toBe(false);
    }
  });

  it('keeps legacy Creator and platform Signal-shaped content compatible', () => {
    const legacy = content({ durationMinutes: 45 });
    expect(isTemplateContent(legacy, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(legacy)).toBe(true);

    const signalShape = content({ category: 'Mathematics', checkpointOrder: 'Creator fixed' });
    expect(isTemplateContent(signalShape, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(signalShape)).toBe(true);
  });
});
