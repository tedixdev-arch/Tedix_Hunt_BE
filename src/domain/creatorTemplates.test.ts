import { describe, expect, it } from 'vitest';
import { signalClujNapocaV1 } from './templates/signalClujNapocaV1.js';
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
  mission: { name: 'Go' }, configuration: {
    finishPoint: { name: 'City Wall', latitude: 46.78, longitude: 23.64, radiusMeters: 5 },
    ...configuration,
  }, scoring: { startingScore: 100 },
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

  it.each([5, 9, 10, 30, 100, 500])('accepts radius %s metres without alteration', (radiusMeters) => {
    const value = content({
      normalCheckpointCount: 1,
      checkpointPositions: [{ ...position(1), radiusMeters }],
    });
    const original = structuredClone(value);
    expect(isTemplateContent(value, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(value)).toBe(true);
    expect(value).toEqual(original);
  });

  it.each([
    -1, 0, 4, 4.999, 500.001, 501, Number.NaN,
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null, undefined, {}, [],
  ])('rejects invalid radius %s in drafts and submissions', (radiusMeters) => {
    const value = content({
      normalCheckpointCount: 1,
      checkpointPositions: [{ ...position(1), radiusMeters }],
    });
    expect(isTemplateContent(value, 'geo-trail', 1)).toBe(false);
    expect(isTemplateContentSubmittable(value)).toBe(false);
  });

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
    const legacy = content({ durationMinutes: 45, finishPoint: undefined });
    expect(isTemplateContent(legacy, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(legacy)).toBe(true);

    const signalShape = signalClujNapocaV1;
    expect(isTemplateContent(signalShape, signalShape.key, 1)).toBe(true);
    expect(isTemplateContentSubmittable(signalShape)).toBe(true);
  });
});

describe('FinishPoint geography', () => {
  const finishPoint = { name: ' City Wall ', latitude: 46.778123, longitude: 23.641234, radiusMeters: 17 };
  const geographic = (finish: unknown) => content({
    normalCheckpointCount: 1, checkpointPositions: [position(1)], finishPoint: finish,
  });

  it('allows omission in drafts but requires FinishPoint at geographic submission without defaulting', () => {
    const draft = geographic(undefined);
    expect(isTemplateContent(draft, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(draft)).toBe(false);
    expect(draft.configuration.finishPoint).toBeUndefined();
  });

  it.each([5, 500])('preserves valid FinishPoint with radius %i and excludes it from normal count', (radiusMeters) => {
    const value = geographic({ ...finishPoint, radiusMeters });
    const original = structuredClone(value);
    expect(isTemplateContent(value, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(value)).toBe(true);
    expect(value).toEqual(original);
    expect(value.configuration).toMatchObject({ normalCheckpointCount: 1 });
    expect(value.configuration).toMatchObject({ checkpointPositions: [position(1)] });
  });

  it.each([
    { latitude: -91 }, { latitude: 91 }, { latitude: Number.NaN }, { latitude: Infinity },
    { longitude: -181 }, { longitude: 181 }, { longitude: -Infinity }, { longitude: '23' },
    { radiusMeters: 4 }, { radiusMeters: 501 }, { radiusMeters: 5.5 }, { radiusMeters: '5' },
    { radiusMeters: undefined }, { name: '' }, { name: '  ' }, { name: 'x'.repeat(101) },
    { checkpointNumber: 2 },
  ])('rejects invalid or incomplete FinishPoint %# in drafts and submissions', (override) => {
    const value = geographic({ ...finishPoint, ...override });
    expect(isTemplateContent(value, 'geo-trail', 1)).toBe(false);
    expect(isTemplateContentSubmittable(value)).toBe(false);
  });

  it.each([null, [], [finishPoint], [finishPoint, finishPoint], {}])(
    'rejects non-single-object FinishPoint %#', (finish) => {
      expect(isTemplateContent(geographic(finish), 'geo-trail', 1)).toBe(false);
      expect(isTemplateContentSubmittable(geographic(finish))).toBe(false);
    },
  );

  it.each([[-90, -180], [90, 180]])('accepts coordinate boundaries %s, %s', (latitude, longitude) => {
    expect(isTemplateContentSubmittable(geographic({
      ...finishPoint, latitude, longitude, name: 'x'.repeat(100),
    }))).toBe(true);
  });

  it('keeps non-geographic legacy submissions valid without adding FinishPoint', () => {
    const legacy = content({ durationMinutes: 45, finishPoint: undefined });
    const original = structuredClone(legacy);
    expect(isTemplateContent(legacy, 'geo-trail', 1)).toBe(true);
    expect(isTemplateContentSubmittable(legacy)).toBe(true);
    expect(legacy).toEqual(original);
  });
});
