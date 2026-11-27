/**
 * Participant gameplay for Template-owned custom exercises (Personal and Team slots; Library allocations use the
 * same embedded payload). The server keeps every answer: participant DTOs are built from per-mechanic allowlists,
 * answers are checked here, and only success feedback is released (D4: no hints, solutions or expected values).
 */
import { createHash } from 'node:crypto';
import { personalMechanics, teamMechanics } from './customExerciseSchemas.js';
import { normalizeAnswer } from './gameplay.js';

type Obj = Record<string, any>;
export type CustomSlot = 'personal' | 'team';
export interface CustomExercise extends Obj {
  id?: string; type: string; classification: CustomSlot; title: string; instructions: string; interaction: Obj; answer: Obj;
  feedback?: { correct?: string; incorrect?: string };
}

const record = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9;
const shortText = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;

/** The authored custom exercise in a checkpoint slot, if it is a supported, well-formed instance. */
export function customExercise(entry: Obj | null, slot: CustomSlot): CustomExercise | null {
  const exercise = record(entry) && record(entry.customExercises) ? entry.customExercises[slot] : undefined;
  const mechanics: Obj = slot === 'personal' ? personalMechanics : teamMechanics;
  if (!record(exercise) || exercise.classification !== slot || !Object.hasOwn(mechanics, exercise.type)
    || !record(exercise.interaction) || !record(exercise.answer) || typeof exercise.title !== 'string') return null;
  return exercise as CustomExercise;
}

/** Deterministic per-participant shuffle, so reloading never reorders a puzzle mid-attempt. */
function shuffled<T>(items: T[], seed: string): T[] {
  const out = [...items];
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0) || 1;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  // A shuffle that lands on the authored order would reveal ordering answers; rotate once in that case.
  if (out.length > 1 && out.every((v, i) => v === items[i])) out.push(out.shift()!);
  return out;
}

const items = (list: unknown) => (Array.isArray(list) ? list : []).filter(record).map(x => ({ id: String(x.id), text: String(x.text) }));

/**
 * Participant-safe interaction per mechanic. Lists whose authored order is (or may be) the answer are shuffled;
 * the memory-card face is withheld until solved because it carries the recall answer.
 */
export function customInteractionDto(exercise: CustomExercise, seed: string): Obj {
  const d = exercise.interaction, mix = <T>(list: T[], name: string) => shuffled(list, `${seed}:${exercise.id ?? exercise.title}:${name}`);
  switch (exercise.type) {
    case 'tap-pair': case 'match-columns': return { left: items(d.left), right: mix(items(d.right), 'right') };
    case 'single-choice': case 'multiple-choice': return { options: items(d.options) };
    case 'true-false': return {};
    case 'memory-card': return { revealDelayMs: Number.isInteger(d.revealDelayMs) ? d.revealDelayMs : 1000 };
    case 'number-line': return { min: d.min, max: d.max, step: d.step };
    case 'drag-drop': return { items: mix(items(d.items), 'items'), targets: items(d.targets) };
    case 'fill-blank': return { blanks: (Array.isArray(d.blanks) ? d.blanks : []).filter(record).map((b: Obj) => ({ id: String(b.id), prompt: String(b.prompt) })) };
    case 'sequence': return { elements: mix(items(d.elements), 'elements') };
    case 'find-mistake': return { steps: items(d.steps), explanations: items(d.explanations) };
    case 'build-problem': return { pieces: mix(items(d.pieces), 'pieces'), slots: items(d.slots) };
    case 'number-pattern': return { terms: (Array.isArray(d.terms) ? d.terms : []).filter(record).map((t: Obj) => ({ id: String(t.id), ...(finite(t.value) ? { value: t.value } : {}) })), missingId: String(d.missingId) };
    case 'shape-pattern': return { terms: (Array.isArray(d.terms) ? d.terms : []).filter(record).map((t: Obj) => ({ id: String(t.id), ...(isId(t.shapeId) ? { shapeId: t.shapeId } : {}) })), missingId: String(d.missingId), shapes: items(d.shapes) };
    case 'rule-discovery': return { examples: (Array.isArray(d.examples) ? d.examples : []).filter(record).map((x: Obj) => ({ input: x.input, output: x.output })), rules: items(d.rules), predictionInput: d.predictionInput };
    case 'scrambled-word': return { contributions: mix(items(d.contributions), 'contributions') };
    case 'distributed-information': return { facts: items(d.facts), options: items(d.options) };
    case 'hypothesis': return { packets: items(d.packets), decoderKey: String(d.decoderKey) };
    case 'assemble-machine': return { contributions: items(d.contributions), frequencies: (Array.isArray(d.frequencies) ? d.frequencies : []).filter(record).map((f: Obj) => ({ id: String(f.id), text: String(f.text), value: f.value })) };
    case 'clue-synthesis': return { clues: items(d.clues), answerPattern: String(d.answerPattern) };
    case 'filter-noise': return { signals: items(d.signals) };
    case 'shared-final-key': return { contributions: mix((Array.isArray(d.contributions) ? d.contributions : []).filter(record).map((c: Obj) => ({ id: String(c.id), digits: String(c.digits) })), 'contributions'), orderingInstructions: String(d.orderingInstructions) };
    default: return {};
  }
}

export const customExerciseDto = (exercise: CustomExercise, seed: string) => ({
  type: exercise.type, classification: exercise.classification, title: exercise.title, instructions: exercise.instructions,
  interaction: customInteractionDto(exercise, seed),
});

/** Revealed only after a correct answer: authored success feedback, and the memory card face. */
export const customRevealDto = (exercise: CustomExercise) => ({
  ...(typeof exercise.feedback?.correct === 'string' ? { successText: exercise.feedback.correct } : {}),
  ...(exercise.type === 'memory-card' && typeof exercise.interaction.card === 'string' ? { recallCard: exercise.interaction.card } : {}),
});

const idList = (value: unknown, max = 40) => Array.isArray(value) && value.length <= max && value.every(isId);
const pairList = (value: unknown, a: string, b: string) => Array.isArray(value) && value.length <= 40
  && value.every(p => record(p) && Object.keys(p).sort().join() === [a, b].sort().join() && isId(p[a]) && isId(p[b]));
const only = (value: Obj, keys: string[]) => Object.keys(value).every(k => keys.includes(k));

/**
 * A participant response has the same shape as the exercise answer (without authoring flags such as caseSensitive).
 * Structural validation only; correctness is decided by checkCustomAnswer.
 */
export function validCustomResponse(type: string, response: unknown): response is Obj {
  if (!record(response)) return false;
  const r = response;
  switch (type) {
    case 'tap-pair': case 'match-columns': return only(r, ['pairs']) && pairList(r.pairs, 'leftId', 'rightId');
    case 'single-choice': case 'distributed-information': return only(r, ['optionId']) && isId(r.optionId);
    case 'true-false': return only(r, ['value']) && typeof r.value === 'boolean';
    case 'memory-card': case 'hypothesis': case 'clue-synthesis': return only(r, ['value']) && shortText(r.value);
    case 'number-line': case 'number-pattern': return only(r, ['value']) && finite(r.value);
    case 'multiple-choice': return only(r, ['optionIds']) && idList(r.optionIds);
    case 'filter-noise': return only(r, ['trustedSignalIds']) && idList(r.trustedSignalIds, 16);
    case 'drag-drop': return only(r, ['assignments']) && pairList(r.assignments, 'itemId', 'targetId');
    case 'fill-blank': return only(r, ['values']) && Array.isArray(r.values) && r.values.length <= 40
      && r.values.every((v: unknown) => record(v) && only(v, ['blankId', 'value']) && isId(v.blankId) && shortText(v.value));
    case 'sequence': return only(r, ['order']) && idList(r.order);
    case 'build-problem': return only(r, ['construction']) && idList(r.construction);
    case 'find-mistake': return only(r, ['stepId', 'explanationId']) && isId(r.stepId) && isId(r.explanationId);
    case 'shape-pattern': return only(r, ['shapeId']) && isId(r.shapeId);
    case 'rule-discovery': return only(r, ['ruleId', 'predictedOutput']) && isId(r.ruleId) && finite(r.predictedOutput);
    case 'scrambled-word': return only(r, ['word']) && shortText(r.word, 200);
    case 'assemble-machine': return only(r, ['frequencyId']) && isId(r.frequencyId);
    case 'shared-final-key': return only(r, ['code', 'order']) && typeof r.code === 'string' && /^[0-9]{1,256}$/.test(r.code)
      && (r.order === undefined || idList(r.order, 16));
    default: return false;
  }
}

const sameSet = (actual: string[], expected: string[]) =>
  new Set(actual).size === actual.length && actual.length === expected.length && expected.every(v => actual.includes(v));
const sameOrder = (actual: string[], expected: string[]) => actual.length === expected.length && expected.every((v, i) => actual[i] === v);
const pairsKey = (pairs: Obj[], a: string, b: string) => pairs.map(p => `${p[a]}\u0000${p[b]}`);
const sameNumber = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-9;
const textMatch = (actual: string, expected: string, caseSensitive: unknown) =>
  normalizeAnswer(actual, caseSensitive === true) === normalizeAnswer(expected, caseSensitive === true);

/** Server-side correctness for every supported mechanic, using the authored answer only. */
export function checkCustomAnswer(exercise: CustomExercise, response: Obj): boolean {
  const a = exercise.answer;
  switch (exercise.type) {
    case 'tap-pair': case 'match-columns':
      return sameSet(pairsKey(response.pairs, 'leftId', 'rightId'), pairsKey(a.pairs, 'leftId', 'rightId'));
    case 'single-choice': case 'distributed-information': return response.optionId === a.optionId;
    case 'true-false': return response.value === a.value;
    case 'memory-card': case 'hypothesis': case 'clue-synthesis': return textMatch(response.value, String(a.value), a.caseSensitive);
    case 'number-line': return Math.abs(response.value - Number(a.target)) <= Number(a.tolerance) + 1e-9;
    case 'number-pattern': return sameNumber(response.value, Number(a.value));
    case 'multiple-choice': return sameSet(response.optionIds, a.optionIds);
    case 'filter-noise': return sameSet(response.trustedSignalIds, a.trustedSignalIds);
    case 'drag-drop': return sameSet(pairsKey(response.assignments, 'itemId', 'targetId'), pairsKey(a.assignments, 'itemId', 'targetId'));
    case 'fill-blank': {
      const given = new Map((response.values as Obj[]).map(v => [v.blankId, v.value]));
      return given.size === a.values.length && (a.values as Obj[]).every(v => typeof given.get(v.blankId) === 'string'
        && textMatch(given.get(v.blankId), String(v.value), a.caseSensitive));
    }
    case 'sequence': return sameOrder(response.order, a.order);
    case 'build-problem': return sameOrder(response.construction, a.construction);
    case 'find-mistake': return response.stepId === a.stepId && response.explanationId === a.explanationId;
    case 'shape-pattern': return response.shapeId === a.shapeId;
    case 'rule-discovery': return response.ruleId === a.ruleId && sameNumber(response.predictedOutput, Number(a.predictedOutput));
    case 'scrambled-word': {
      const squash = (v: string) => v.normalize('NFC').replace(/\s+/g, '');
      return a.caseSensitive === true ? squash(response.word) === squash(String(a.word)) : squash(response.word).toUpperCase() === squash(String(a.word)).toUpperCase();
    }
    case 'assemble-machine': return response.frequencyId === a.frequencyId;
    // The combined digits are the key; an ordering, when sent, must also be the authored one.
    case 'shared-final-key': return response.code === a.code && (response.order === undefined || sameOrder(response.order, a.order));
    default: return false;
  }
}
