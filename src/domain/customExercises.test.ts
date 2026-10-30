import { describe, expect, it } from 'vitest';
import { allocateCustomExercises, copyCustomExercises, hasValidPersistedCustomOwnership, projectHuntForReader, validateCustomExercises } from './customExercises.js';
import { isTemplateContent, isTemplateContentSubmittable } from './creatorTemplates.js';
import { customTemplateFixture, exerciseFixtures } from '../test/customExercises.js';
import { swaggerSpec } from '../lib/swagger.js';

describe('version-owned data-only exercises', () => {
  for (const e of exerciseFixtures) {
    it(`${e.type}: validates and preserves every field`, () => {
      const content = customTemplateFixture('fixture', 1, [e]);
      expect(validateCustomExercises(content)).toEqual([]);
      expect(isTemplateContent(content, 'fixture', 1)).toBe(true);
      const saved: any = allocateCustomExercises(content, 'fixture', 1);
      const instance = saved.checkpoints[0].customExercises[e.classification];
      const { id, owner, ...data } = instance;
      expect(data).toEqual(e); expect(owner).toEqual({ templateKey: 'fixture', version: 1 });
      expect(id).toMatch(/^[0-9a-f-]{36}$/); expect(content.checkpoints[0].customExercises[e.classification]).toEqual(e);
      expect(hasValidPersistedCustomOwnership(saved)).toBe(true);
      expect(isTemplateContentSubmittable(saved, 'universal')).toBe(true);
    });
    it(`${e.type}: rejects missing answers, schema changes, extra executable fields and wrong classification`, () => {
      for (const patch of [{ answer: {} }, { schemaVersion: 2 }, { engine: 'eval(input)' }, { classification: e.classification === 'personal' ? 'team' : 'personal' }]) {
        const content = customTemplateFixture('fixture', 1, [e]);
        Object.assign(content.checkpoints[0].customExercises[e.classification], patch);
        expect(validateCustomExercises(content).length).toBeGreaterThan(0);
        expect(isTemplateContent(content, 'fixture', 1)).toBe(false);
      }
    });
  }
  const invalidData: Record<string, object> = {
    'tap-pair': { pairs: [{ leftId: 'a', rightId: 'a' }, { leftId: 'a', rightId: 'b' }] },
    'single-choice': { optionId: 'missing' }, 'multiple-choice': { optionIds: ['a', 'a'] },
    'match-columns': { pairs: [{ leftId: 'a', rightId: 'x' }] },
    'drag-drop': { assignments: [{ itemId: 'a', targetId: 'x' }] },
    'fill-blank': { values: [{ blankId: 'missing', value: '4' }] }, sequence: { order: ['a', 'a'] },
    'find-mistake': { explanationId: 'missing' }, 'build-problem': { construction: ['a', 'a'] },
    'number-line': { target: 4.3 }, 'shape-pattern': { shapeId: 'missing' }, 'rule-discovery': { ruleId: 'missing' },
    'scrambled-word': { word: 'AC' }, 'distributed-information': { optionId: 'missing' },
    'assemble-machine': { frequencyId: 'missing' }, 'filter-noise': { trustedSignalIds: ['missing'] }, 'shared-final-key': { code: '0123' },
  };
  it.each(Object.entries(invalidData))('%s rejects invalid answer membership, mapping or numeric constraints', (type, patch) => {
    const e = structuredClone(exerciseFixtures.find(e => e.type === type)!);
    Object.assign(e.answer, patch);
    expect(validateCustomExercises(customTemplateFixture('fixture', 1, [e])).length).toBeGreaterThan(0);
  });
  it('rejects invalid delayed recall, missing-slot patterns, duplicate inventory, text and collection limits', () => {
    for (const [type, patch] of [
      ['memory-card', { revealDelayMs: 500 }], ['number-pattern', { missingId: 'a' }],
      ['shape-pattern', { missingId: 'x' }], ['sequence', { elements: [{ id: 'a', text: 'A' }, { id: 'a', text: 'B' }] }],
      ['number-line', { step: 0 }], ['number-line', { max: Infinity }],
      ['single-choice', { options: Array(41).fill({ id: 'a', text: 'A' }) }],
    ] as const) {
      const e = structuredClone(exerciseFixtures.find(e => e.type === type)!);
      Object.assign(e.interaction, patch);
      expect(validateCustomExercises(customTemplateFixture('fixture', 1, [e])).length).toBeGreaterThan(0);
    }
    for (const title of [' ', 'x'.repeat(201), '<script>alert(1)</script>']) {
      const e = { ...exerciseFixtures[0], title };
      expect(validateCustomExercises(customTemplateFixture('fixture', 1, [e])).length).toBeGreaterThan(0);
    }
  });
  it('allocates independent versions and copies; rejects foreign, stale, duplicate and moved IDs', () => {
    const first: any = allocateCustomExercises(customTemplateFixture(), 'custom-fixture', 1);
    const next: any = allocateCustomExercises({ ...first, version: 2 }, 'custom-fixture', 2, first);
    const copy = copyCustomExercises(first, 'destination', 1);
    const instance = (c: any) => c.checkpoints[0].customExercises.personal;
    expect(instance(next).id).not.toBe(instance(first).id); expect(instance(copy).id).not.toBe(instance(first).id);
    expect(instance(copy).owner).toEqual({ templateKey: 'destination', version: 1 });
    instance(next).title = 'Changed'; expect(instance(first).title).toBe(exerciseFixtures[0].title);
    expect(() => allocateCustomExercises({ ...first, key: 'other' }, 'other', 1)).toThrow(/invalid_custom/);
    expect(() => allocateCustomExercises({ ...first, version: 3 }, 'custom-fixture', 3, next)).toThrow(/invalid_custom/);
    const moved = structuredClone(first); moved.version = 2;
    moved.checkpoints[1].customExercises = moved.checkpoints[0].customExercises; delete moved.checkpoints[0].customExercises;
    expect(() => allocateCustomExercises(moved, 'custom-fixture', 2, first)).toThrow(/invalid_custom/);
    const duplicated = structuredClone(first); duplicated.checkpoints[1].customExercises = duplicated.checkpoints[0].customExercises;
    expect(validateCustomExercises(duplicated).some(i => /Duplicate/.test(i.message))).toBe(true);
    instance(first).owner.version = 2; expect(hasValidPersistedCustomOwnership(first)).toBe(false);
  });
  it('rejects ambiguous assignments, unsupported slots and pathological payloads', () => {
    for (const change of [
      (c: any) => { c.checkpoints[1].checkpoint = 2; },
      (c: any) => { c.checkpoints[0].checkpoint = 2; },
      (c: any) => { c.checkpoints[0].customExercises.extra = {}; },
      (c: any) => { c.checkpoints[0].customExercises = {}; },
      (c: any) => { c.extra = 'x'.repeat(102401); },
      (c: any) => { c.extra = {}; let o = c.extra; for (let i = 0; i < 20; i++) o = o.nested = {}; },
    ]) {
      const c = customTemplateFixture(); change(c); expect(validateCustomExercises(c).length).toBeGreaterThan(0);
    }
  });
  it('bounds error reporting without checking relations against unvalidated later instances', () => {
    const c = customTemplateFixture();
    Object.assign(c.checkpoints[0].customExercises.personal, Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`extra${i}`, true])));
    c.checkpoints[1].customExercises = { personal: { type: 'sequence', classification: 'personal' } };
    expect(validateCustomExercises(c)).toHaveLength(30);
  });
  it('keeps predefined data unchanged and custom snapshots private to Organizers', () => {
    const legacy = { key: 'legacy', checkpoints: [{ arbitrary: ['unchanged'] }] };
    expect(allocateCustomExercises(legacy, 'legacy', 1)).toBe(legacy);
    const hunt = { templateSnapshot: customTemplateFixture(), other: 'preserved' };
    expect(projectHuntForReader(hunt, true)).toBe(hunt);
    expect(projectHuntForReader(hunt, false)).toEqual({ ...hunt, templateSnapshot: null });
    expect(projectHuntForReader({ templateSnapshot: legacy }, false).templateSnapshot).toBe(legacy);
  });
  it('publishes exact type-specific data schemas to OpenAPI', () => {
    const spec = swaggerSpec as any;
    const schemas = spec.components.schemas.CustomExercise.oneOf;
    expect(schemas).toHaveLength(22);
    expect(spec.components.schemas.CustomPersonalExercise.oneOf).toHaveLength(15);
    expect(spec.components.schemas.CustomTeamExercise.oneOf).toHaveLength(7);
    for (const e of exerciseFixtures) {
      const s = schemas.find((s: any) => s.properties.type.enum[0] === e.type);
      expect(s.properties.answer.additionalProperties).toBe(false);
      expect(s.properties.interaction.required).toEqual(Object.keys(e.interaction));
    }
  });
});
