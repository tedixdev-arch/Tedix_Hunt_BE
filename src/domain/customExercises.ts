import { randomUUID } from 'node:crypto';
import { exerciseSchema, mechanics, type Schema } from './customExerciseSchemas.js';

type RecordValue = Record<string, any>;
const record = (v: unknown): v is RecordValue => typeof v === 'object' && v !== null && !Array.isArray(v);
export interface ExerciseIssue { path: string; message: string }
export class CustomExerciseValidationError extends Error {
  constructor(public readonly details: ExerciseIssue[]) { super('invalid_custom_exercises'); }
}
const slots = ['personal', 'team'] as const;

// Bounded iterative traversal precedes schema recursion, including for model callers.
const bounded = (value: unknown): boolean => {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > 12000 || next.depth > 12) return false;
    if (next.value && typeof next.value === 'object') {
      for (const v of Object.values(next.value)) pending.push({ value: v, depth: next.depth + 1 });
    }
  }
  try { return Buffer.byteLength(JSON.stringify(value) ?? '') <= 100 * 1024; } catch { return false; }
};

const validateSchema = (s: Schema, v: unknown, path: string, issues: ExerciseIssue[]) => {
  if (issues.length >= 30) return;
  const fail = (message: string) => issues.push({ path, message });
  if (s.enum && !s.enum.includes(v as never)) return void fail('Unsupported value');
  if (s.type === 'object') {
    if (!record(v)) return void fail('Expected object');
    for (const name of Object.keys(v)) if (!Object.hasOwn(s.properties!, name)) issues.push({ path: `${path}.${name}`, message: 'Unsupported field' });
    for (const name of s.required!) if (!Object.hasOwn(v, name)) issues.push({ path: `${path}.${name}`, message: 'Required field' });
    for (const [name, schema] of Object.entries(s.properties!)) if (Object.hasOwn(v, name)) validateSchema(schema, v[name], `${path}.${name}`, issues);
  } else if (s.type === 'array') {
    if (!Array.isArray(v) || v.length < s.minItems! || v.length > s.maxItems!) return void fail(`Expected ${s.minItems}..${s.maxItems} items`);
    v.forEach((entry, i) => validateSchema(s.items!, entry, `${path}[${i}]`, issues));
  } else if (s.type === 'string') {
    if (typeof v !== 'string' || v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity)
      || (s.pattern && !new RegExp(s.pattern).test(v))) fail('Invalid plain text or identifier');
  } else if (s.type === 'boolean') {
    if (typeof v !== 'boolean') fail('Expected boolean');
  } else if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isSafeInteger(v))
    || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity)) fail('Invalid finite number or range');
};

const relationalErrors = (e: RecordValue): string[] => {
  const d = e.interaction, a = e.answer, errors: string[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) errors.push(message); };
  const unique = (xs: unknown[]) => new Set(xs).size === xs.length;
  const ids = (xs: RecordValue[]) => xs.map(x => x.id);
  const member = (id: string, xs: RecordValue[]) => ids(xs).includes(id);
  const complete = (values: string[], xs: RecordValue[]) => values.length === xs.length && unique(values) && values.every(v => member(v, xs));
  for (const collection of Object.values(d)) {
    if (Array.isArray(collection) && collection.length && record(collection[0]) && 'id' in collection[0])
      check(unique(ids(collection)), 'Duplicate interaction item ID');
  }
  switch (e.type) {
    case 'single-choice': case 'distributed-information': check(member(a.optionId, d.options), 'Answer must reference an option'); break;
    case 'multiple-choice': check(unique(a.optionIds) && a.optionIds.every((v: string) => member(v, d.options)), 'Answer IDs must be distinct options'); break;
    case 'tap-pair': case 'match-columns':
      check(complete(a.pairs.map((p: RecordValue) => p.leftId), d.left) && complete(a.pairs.map((p: RecordValue) => p.rightId), d.right), 'Pairs must map each left and right item exactly once'); break;
    case 'drag-drop': check(complete(a.assignments.map((p: RecordValue) => p.itemId), d.items)
      && a.assignments.every((p: RecordValue) => member(p.targetId, d.targets)), 'Every item must have one valid target'); break;
    case 'fill-blank': check(complete(a.values.map((p: RecordValue) => p.blankId), d.blanks), 'Every blank must have exactly one answer'); break;
    case 'sequence': check(complete(a.order, d.elements), 'Order must contain every element exactly once'); break;
    case 'find-mistake': check(member(a.stepId, d.steps) && member(a.explanationId, d.explanations), 'Both answer stages must reference valid items'); break;
    case 'build-problem': check(a.construction.length === d.slots.length && unique(a.construction)
      && a.construction.every((v: string) => member(v, d.pieces)), 'Construction requires one distinct inventory piece per slot'); break;
    case 'number-line': {
      const ticks = (d.max - d.min) / d.step, targetTick = (a.target - d.min) / d.step;
      check(d.min < d.max && ticks <= 1000000 && Math.abs(ticks - Math.round(ticks)) < 1e-7
        && a.target >= d.min && a.target <= d.max && Math.abs(targetTick - Math.round(targetTick)) < 1e-7
        && a.tolerance <= d.max - d.min, 'Range and target must be reachable on the tick grid; tolerance must fit range'); break;
    }
    case 'number-pattern': case 'shape-pattern': {
      const field = e.type === 'number-pattern' ? 'value' : 'shapeId';
      check(d.terms.length >= 3 && d.terms.filter((v: RecordValue) => !Object.hasOwn(v, field)).length === 1
        && d.terms.some((v: RecordValue) => v.id === d.missingId && !Object.hasOwn(v, field)), 'Pattern needs one identified missing slot and at least three terms');
      if (e.type === 'shape-pattern') check(member(a.shapeId, d.shapes)
        && d.terms.every((v: RecordValue) => v.shapeId === undefined || member(v.shapeId, d.shapes)), 'Shapes must reference allowed choices'); break;
    }
    case 'rule-discovery': check(member(a.ruleId, d.rules), 'Answer must reference an allowed rule');
      check(unique(d.examples.map((v: RecordValue) => v.input)), 'Example inputs must be distinct'); break;
    case 'assemble-machine': check(member(a.frequencyId, d.frequencies) && unique(d.frequencies.map((v: RecordValue) => v.value)), 'Answer must reference a distinct frequency choice'); break;
    case 'filter-noise': check(unique(a.trustedSignalIds) && a.trustedSignalIds.every((v: string) => member(v, d.signals)), 'Trusted IDs must be distinct named signals'); break;
    case 'scrambled-word': {
      const letters = (s: string) => [...(a.caseSensitive ? s : s.toUpperCase()).replace(/\s/gu, '')].sort().join('');
      check(letters(d.contributions.map((v: RecordValue) => v.text).join('')) === letters(a.word), 'Contributions must reconstruct the answer word'); break;
    }
    case 'shared-final-key': check(complete(a.order, d.contributions)
      && a.order.map((id: string) => d.contributions.find((v: RecordValue) => v.id === id)?.digits).join('') === a.code, 'Code must equal all digit contributions in the answer order'); break;
  }
  return errors;
};

export const hasCustomExercises = (content: unknown): boolean => record(content) && Array.isArray(content.checkpoints)
  && content.checkpoints.some((c: unknown) => record(c) && Object.hasOwn(c, 'customExercises'));

export function validateCustomExercises(content: unknown): ExerciseIssue[] {
  if (!hasCustomExercises(content)) return [];
  if (!bounded(content)) return [{ path: 'content', message: 'Custom template exceeds 100 KiB, depth 12 or 12000 values' }];
  const c = content as RecordValue, issues: ExerciseIssue[] = [], seen = new Set<string>(), numbers = new Set<number>();
  if (c.checkpoints.length > 21) return [{ path: 'content.checkpoints', message: 'At most 20 normal checkpoints plus FinishPoint' }];
  c.checkpoints.forEach((checkpoint: unknown, index: number) => {
    if (!record(checkpoint)) return;
    const path = `content.checkpoints[${index}]`;
    // Custom authoring opts into unambiguous assignments even for legacy-shaped content.
    if (checkpoint.role !== 'terminal') {
      const n = checkpoint.checkpoint;
      if (!Number.isInteger(n) || n < 1 || n > (c.configuration?.normalCheckpointCount ?? 20) || numbers.has(n)
        || (checkpoint.checkpointNumber !== undefined && checkpoint.checkpointNumber !== n)) issues.push({ path, message: 'Normal checkpoints need unique valid checkpoint numbers' });
      numbers.add(n);
    } else if (checkpoint.checkpoint !== undefined || checkpoint.checkpointNumber !== undefined) issues.push({ path, message: 'FinishPoint must be unnumbered' });
    if (!Object.hasOwn(checkpoint, 'customExercises')) return;
    const custom = checkpoint.customExercises;
    if (!record(custom) || !Object.keys(custom).length || Object.keys(custom).some(k => !slots.includes(k as never))) {
      issues.push({ path: `${path}.customExercises`, message: 'Expected personal and/or team slot' }); return;
    }
    for (const slot of slots) {
      if (!Object.hasOwn(custom, slot)) continue;
      const e = custom[slot], p = `${path}.customExercises.${slot}`;
      if (!record(e) || typeof e.type !== 'string' || !Object.hasOwn(mechanics, e.type)) {
        issues.push({ path: p, message: 'Unsupported exercise type' }); continue;
      }
      const before = issues.length;
      validateSchema(exerciseSchema(e.type as keyof typeof mechanics), e, p, issues);
      if (e.classification !== slot) issues.push({ path: p, message: 'Classification must match checkpoint slot' });
      if ((e.id === undefined) !== (e.owner === undefined)) issues.push({ path: p, message: 'ID and owner must be supplied together or both omitted' });
      if (e.id !== undefined) {
        if (seen.has(e.id)) issues.push({ path: p, message: 'Duplicate exercise instance ID' });
        seen.add(e.id);
      }
      if (before < 30 && before === issues.length) for (const message of relationalErrors(e)) issues.push({ path: p, message });
    }
  });
  if (c.checkpoints.filter((cp: RecordValue) => cp?.role === 'terminal').length > 1) issues.push({ path: 'content.checkpoints', message: 'Only one FinishPoint is allowed' });
  return issues.slice(0, 30);
}

const entries = (content: RecordValue): { exercise: RecordValue; slot: string; assignment: string }[] =>
  content.checkpoints.flatMap((cp: RecordValue) => slots.flatMap(slot => cp.customExercises?.[slot]
    ? [{ exercise: cp.customExercises[slot], slot, assignment: cp.role === 'terminal' ? 'terminal' : String(cp.checkpoint) }] : []));

/** Input IDs are references only to the latest source snapshot at the same slot. New content omits both. */
export function allocateCustomExercises(content: unknown, key: string, version: number, previous?: unknown): unknown {
  const issues = validateCustomExercises(content);
  if (issues.length) throw new CustomExerciseValidationError(issues);
  if (!hasCustomExercises(content)) return content;
  const source = record(previous) && hasCustomExercises(previous) ? entries(previous) : [];
  const result = structuredClone(content) as RecordValue;
  for (const { exercise, slot, assignment } of entries(result)) {
    if (exercise.id !== undefined && !source.some(s => s.exercise.id === exercise.id && s.slot === slot && s.assignment === assignment
      && s.exercise.owner.templateKey === key && s.exercise.owner.version === (previous as RecordValue).version
      && exercise.owner.templateKey === key && exercise.owner.version === s.exercise.owner.version)) {
      throw new CustomExerciseValidationError([{ path: 'content.checkpoints.customExercises', message: 'Instance must belong to the latest source version and same checkpoint slot; omit ID and owner for a new instance' }]);
    }
    exercise.id = randomUUID();
    exercise.owner = { templateKey: key, version };
  }
  return result;
}

/** Trusted copy path: discard source identity, then allocate destination-owned instances. */
export function copyCustomExercises(content: RecordValue, key: string, version: number): RecordValue {
  if (!hasCustomExercises(content)) return { ...content, key, version };
  const result = structuredClone(content);
  result.key = key; result.version = version;
  for (const { exercise } of entries(result)) { delete exercise.id; delete exercise.owner; }
  return allocateCustomExercises(result, key, version) as RecordValue;
}

export function hasValidPersistedCustomOwnership(content: unknown): boolean {
  if (!hasCustomExercises(content)) return true;
  if (validateCustomExercises(content).length) return false;
  const c = content as RecordValue;
  return entries(c).every(({ exercise: e }) => e.id !== undefined && e.owner?.templateKey === c.key && e.owner?.version === c.version);
}

/** No custom gameplay is delivered yet, even to participants with a supervisor context. */
export function projectHuntForReader<T extends { templateSnapshot: unknown }>(hunt: T, organizer: boolean): T {
  return !organizer && hasCustomExercises(hunt.templateSnapshot) ? { ...hunt, templateSnapshot: null } : hunt;
}
