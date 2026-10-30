// A deliberately small data-only schema vocabulary, shared by validation and OpenAPI.
export interface Schema {
  type: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: (string | number | boolean)[];
}
export const text = (maxLength = 2000): Schema => ({ type: 'string', minLength: 1, maxLength,
  pattern: '^(?![\\s\\S]*<[/!a-zA-Z])(?![\\s\\S]*[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f])[\\s\\S]*\\S[\\s\\S]*$' });
export const idSchema: Schema = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' };
export const uuidSchema: Schema = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
export const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false });
export const array = (items: Schema, minItems = 1, maxItems = 40): Schema => ({ type: 'array', items, minItems, maxItems });
const number = (minimum = -1e9, maximum = 1e9): Schema => ({ type: 'number', minimum, maximum });
const integer = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum });
const item = object({ id: idSchema, text: text() });
const items = array(item, 2);
const ids = array(idSchema);
const pair = object({ leftId: idSchema, rightId: idSchema });
const contributions = array(item, 2, 16);
export const personalMechanics = {
  'tap-pair': { interaction: object({ left: items, right: items }), answer: object({ pairs: array(pair, 2) }) },
  'single-choice': { interaction: object({ options: items }), answer: object({ optionId: idSchema }) },
  'true-false': { interaction: object({}), answer: object({ value: { type: 'boolean' } }) },
  'memory-card': { interaction: object({ card: text(), revealDelayMs: integer(1000, 60000) }), answer: object({ value: text(500), caseSensitive: { type: 'boolean' } }) },
  'number-line': { interaction: object({ min: number(), max: number(), step: number(0.000001) }), answer: object({ target: number(), tolerance: number(0) }) },
  'multiple-choice': { interaction: object({ options: items }), answer: object({ optionIds: ids }) },
  'match-columns': { interaction: object({ left: items, right: items }), answer: object({ pairs: array(pair, 2) }) },
  'drag-drop': { interaction: object({ items, targets: items }), answer: object({ assignments: array(object({ itemId: idSchema, targetId: idSchema }), 2) }) },
  'fill-blank': { interaction: object({ blanks: array(object({ id: idSchema, prompt: text() })) }), answer: object({ values: array(object({ blankId: idSchema, value: text(500) })), caseSensitive: { type: 'boolean' } }) },
  sequence: { interaction: object({ elements: items }), answer: object({ order: array(idSchema, 2) }) },
  'find-mistake': { interaction: object({ steps: items, explanations: items }), answer: object({ stepId: idSchema, explanationId: idSchema }) },
  'build-problem': { interaction: object({ pieces: items, slots: array(item) }), answer: object({ construction: ids }) },
  'number-pattern': { interaction: object({ terms: array(object({ id: idSchema, value: number() }, ['id'])), missingId: idSchema }), answer: object({ value: number() }) },
  'shape-pattern': { interaction: object({ terms: array(object({ id: idSchema, shapeId: idSchema }, ['id'])), missingId: idSchema, shapes: items }), answer: object({ shapeId: idSchema }) },
  'rule-discovery': { interaction: object({ examples: array(object({ input: number(), output: number() }), 2), rules: items, predictionInput: number() }), answer: object({ ruleId: idSchema, predictedOutput: number() }) },
};
export const teamMechanics = {
  'scrambled-word': { interaction: object({ contributions }), answer: object({ word: text(100), caseSensitive: { type: 'boolean' } }) },
  'distributed-information': { interaction: object({ facts: contributions, options: items }), answer: object({ optionId: idSchema }) },
  hypothesis: { interaction: object({ packets: contributions, decoderKey: text() }), answer: object({ value: text(500), caseSensitive: { type: 'boolean' } }) },
  'assemble-machine': { interaction: object({ contributions, frequencies: array(object({ id: idSchema, text: text(100), value: number(0) }), 2) }), answer: object({ frequencyId: idSchema }) },
  'clue-synthesis': { interaction: object({ clues: contributions, answerPattern: text(200) }), answer: object({ value: text(500), caseSensitive: { type: 'boolean' } }) },
  'filter-noise': { interaction: object({ signals: contributions }), answer: object({ trustedSignalIds: ids }) },
  'shared-final-key': { interaction: object({ contributions: array(object({ id: idSchema, digits: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[0-9]+$' } }), 2, 16), orderingInstructions: text() }), answer: object({ order: array(idSchema, 2, 16), code: { type: 'string', minLength: 2, maxLength: 256, pattern: '^[0-9]+$' } }) },
};
export const mechanics = { ...personalMechanics, ...teamMechanics };
export const ownerSchema = object({ templateKey: { type: 'string', maxLength: 100, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }, version: integer(1, 2147483647) });
export const exerciseSchema = (type: keyof typeof mechanics): Schema => object({
  id: uuidSchema, owner: ownerSchema, type: { type: 'string', enum: [type] },
  classification: { type: 'string', enum: [Object.hasOwn(personalMechanics, type) ? 'personal' : 'team'] },
  schemaVersion: { type: 'integer', enum: [1] }, title: text(200), instructions: text(4000),
  interaction: mechanics[type].interaction, answer: mechanics[type].answer,
  hints: array(text(), 0, 10), solution: text(4000), feedback: object({ correct: text(), incorrect: text() }),
}, ['type', 'classification', 'schemaVersion', 'title', 'instructions', 'interaction', 'answer', 'hints', 'solution', 'feedback']);
