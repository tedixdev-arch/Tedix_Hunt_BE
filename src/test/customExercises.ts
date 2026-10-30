const choices = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }];
const pairs = [{ leftId: 'a', rightId: 'b' }, { leftId: 'b', rightId: 'a' }];
export const exerciseFixtures = Object.entries({
  'tap-pair': [{ left: choices, right: choices }, { pairs }],
  'single-choice': [{ options: choices }, { optionId: 'a' }],
  'true-false': [{}, { value: false }],
  'memory-card': [{ card: 'Recall 81', revealDelayMs: 1000 }, { value: '81', caseSensitive: false }],
  'number-line': [{ min: 0, max: 10, step: 0.5 }, { target: 4.5, tolerance: 0.1 }],
  'multiple-choice': [{ options: choices }, { optionIds: ['a', 'b'] }],
  'match-columns': [{ left: choices, right: choices }, { pairs }],
  'drag-drop': [{ items: choices, targets: choices }, { assignments: [{ itemId: 'a', targetId: 'b' }, { itemId: 'b', targetId: 'b' }] }],
  'fill-blank': [{ blanks: [{ id: 'a', prompt: '2 + 2 = ___' }] }, { values: [{ blankId: 'a', value: '4' }], caseSensitive: false }],
  sequence: [{ elements: choices }, { order: ['b', 'a'] }],
  'find-mistake': [{ steps: choices, explanations: choices }, { stepId: 'a', explanationId: 'b' }],
  'build-problem': [{ pieces: choices, slots: choices }, { construction: ['b', 'a'] }],
  'number-pattern': [{ terms: [{ id: 'a', value: 3 }, { id: 'b', value: 12 }, { id: 'c' }], missingId: 'c' }, { value: 48 }],
  'shape-pattern': [{ terms: [{ id: 'x', shapeId: 'a' }, { id: 'y', shapeId: 'b' }, { id: 'z' }], missingId: 'z', shapes: choices }, { shapeId: 'a' }],
  'rule-discovery': [{ examples: [{ input: 1, output: 2 }, { input: 2, output: 4 }], rules: choices, predictionInput: 3 }, { ruleId: 'b', predictedOutput: 6 }],
  'scrambled-word': [{ contributions: choices }, { word: 'BA', caseSensitive: false }],
  'distributed-information': [{ facts: choices, options: choices }, { optionId: 'a' }],
  hypothesis: [{ packets: choices, decoderKey: 'A=1, B=2' }, { value: '12', caseSensitive: false }],
  'assemble-machine': [{ contributions: choices, frequencies: [{ id: 'a', text: '100 Hz', value: 100 }, { id: 'b', text: '200 Hz', value: 200 }] }, { frequencyId: 'b' }],
  'clue-synthesis': [{ clues: choices, answerPattern: 'Two letters' }, { value: 'AB', caseSensitive: false }],
  'filter-noise': [{ signals: choices }, { trustedSignalIds: ['b'] }],
  'shared-final-key': [{ contributions: [{ id: 'a', digits: '01' }, { id: 'b', digits: '23' }], orderingInstructions: 'B then A' }, { order: ['b', 'a'], code: '2301' }],
}).map(([type, [interaction, answer]], i) => ({
  type, classification: i < 15 ? 'personal' : 'team', schemaVersion: 1,
  title: '  Authored title  ', instructions: 'Question\nwith Unicode: ă ●', interaction, answer,
  hints: [' First hint ', 'Next hint'], solution: 'Explain\nall stages', feedback: { correct: 'Correct', incorrect: 'Try again' },
}));

export const customTemplateFixture = (key = 'custom-fixture', version = 1, exercises = exerciseFixtures.slice(0, 1)): any => ({
  key, version, displayName: 'Custom fixture', theme: 'Numbers', mission: { name: 'Find' },
  configuration: { normalCheckpointCount: 1 }, scoring: { startingScore: 100 },
  checkpoints: [{ checkpoint: 1, role: 'normal', kind: 'hidden-rule', arbitrary: ['legacy preserved'],
    customExercises: { [exercises[0].classification]: structuredClone(exercises[0]) } },
  { role: 'terminal', teamKind: 'shared-final-key', ...(exercises[1] ? { customExercises: { [exercises[1].classification]: structuredClone(exercises[1]) } } : {}) }],
});
