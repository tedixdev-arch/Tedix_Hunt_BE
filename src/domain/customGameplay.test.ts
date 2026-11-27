import { describe, expect, it } from 'vitest';
import { exerciseFixtures } from '../test/customExercises.js';
import { checkCustomAnswer, customExercise, customExerciseDto, customRevealDto, validCustomResponse, type CustomExercise } from './customGameplay.js';
import { scoringPolicy, validAnswerBody } from './gameplay.js';

const byType = Object.fromEntries(exerciseFixtures.map(e => [e.type, e as unknown as CustomExercise]));
/** The correct participant response is the authored answer minus authoring-only flags. */
const correctResponse = (e: CustomExercise) => {
  const { caseSensitive: _flag, ...answer } = e.answer as Record<string, unknown>;
  if (e.type === 'tap-pair' || e.type === 'match-columns') return { pairs: answer.pairs };
  if (e.type === 'number-line') return { value: answer.target };
  return answer;
};

const wrong: Record<string, Record<string, unknown>> = {
  'tap-pair': { pairs: [{ leftId: 'a', rightId: 'a' }, { leftId: 'b', rightId: 'b' }] },
  'single-choice': { optionId: 'b' }, 'true-false': { value: true }, 'memory-card': { value: '80' },
  'number-line': { value: 4.7 }, 'multiple-choice': { optionIds: ['a'] },
  'match-columns': { pairs: [{ leftId: 'a', rightId: 'a' }, { leftId: 'b', rightId: 'b' }] },
  'drag-drop': { assignments: [{ itemId: 'a', targetId: 'a' }, { itemId: 'b', targetId: 'b' }] },
  'fill-blank': { values: [{ blankId: 'a', value: '5' }] }, sequence: { order: ['a', 'b'] },
  'find-mistake': { stepId: 'a', explanationId: 'a' }, 'build-problem': { construction: ['a', 'b'] },
  'number-pattern': { value: 47 }, 'shape-pattern': { shapeId: 'b' }, 'rule-discovery': { ruleId: 'b', predictedOutput: 7 },
  'scrambled-word': { word: 'AB' }, 'distributed-information': { optionId: 'b' }, hypothesis: { value: '21' },
  'assemble-machine': { frequencyId: 'a' }, 'clue-synthesis': { value: 'BA' }, 'filter-noise': { trustedSignalIds: ['a', 'b'] },
  'shared-final-key': { code: '0123' },
};

describe('custom exercise gameplay', () => {
  it.each(exerciseFixtures.map(e => e.type))('%s: accepts the authored answer and rejects a wrong one', type => {
    const exercise = byType[type];
    const right = correctResponse(exercise);
    expect(validCustomResponse(type, right)).toBe(true);
    expect(checkCustomAnswer(exercise, right)).toBe(true);
    expect(validCustomResponse(type, wrong[type])).toBe(true);
    expect(checkCustomAnswer(exercise, wrong[type])).toBe(false);
  });

  it('normalizes text answers and honours case sensitivity', () => {
    expect(checkCustomAnswer(byType['memory-card'], { value: '  81 ' })).toBe(true);
    expect(checkCustomAnswer(byType['scrambled-word'], { word: ' b a ' })).toBe(true);
    expect(checkCustomAnswer({ ...byType['clue-synthesis'], answer: { value: 'AB', caseSensitive: true } }, { value: 'ab' })).toBe(false);
    expect(checkCustomAnswer(byType['fill-blank'], { values: [] })).toBe(false);
    expect(checkCustomAnswer(byType['multiple-choice'], { optionIds: ['a', 'a'] })).toBe(false);
    expect(checkCustomAnswer(byType['number-line'], { value: 4.6 })).toBe(true);
    expect(checkCustomAnswer(byType['shared-final-key'], { code: '2301', order: ['a', 'b'] })).toBe(false);
  });

  it('rejects malformed responses', () => {
    expect(validCustomResponse('single-choice', { optionId: '<b>' })).toBe(false);
    expect(validCustomResponse('single-choice', { optionId: 'a', extra: 1 })).toBe(false);
    expect(validCustomResponse('number-line', { value: 'NaN' })).toBe(false);
    expect(validCustomResponse('true-false', { value: 'true' })).toBe(false);
    expect(validCustomResponse('sequence', { order: Array.from({ length: 41 }, (_, i) => `x${i}`) })).toBe(false);
    expect(validCustomResponse('shared-final-key', { code: '12a' })).toBe(false);
    expect(validCustomResponse('unknown-type', {})).toBe(false);
    expect(validCustomResponse('tap-pair', null)).toBe(false);
  });

  it('never sends answers, hints, solutions or the memory card face to participants', () => {
    for (const exercise of exerciseFixtures as unknown as CustomExercise[]) {
      const dto = customExerciseDto(exercise, 'seed');
      const json = JSON.stringify(dto);
      expect(Object.keys(dto).sort()).toEqual(['classification', 'instructions', 'interaction', 'title', 'type']);
      expect(json).not.toContain('Explain'); expect(json).not.toContain('First hint'); expect(json).not.toContain('"answer"');
    }
    expect(customExerciseDto(byType['memory-card'], 's').interaction).toEqual({ revealDelayMs: 1000 });
    expect(customRevealDto(byType['memory-card'])).toEqual({ successText: 'Correct', recallCard: 'Recall 81' });
  });

  it('shuffles order-revealing lists deterministically per seed and never in the authored order', () => {
    const sequence = { ...byType.sequence, interaction: { elements: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, text: id.toUpperCase() })) } };
    const first = customExerciseDto(sequence, 'participant-1').interaction.elements.map((e: any) => e.id);
    expect(customExerciseDto(sequence, 'participant-1').interaction.elements.map((e: any) => e.id)).toEqual(first);
    expect(first).not.toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([...first].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('reads only well-formed slots of the right classification', () => {
    const entry = { checkpoint: 1, customExercises: { personal: byType['single-choice'], team: byType['single-choice'] } };
    expect(customExercise(entry, 'personal')?.type).toBe('single-choice');
    expect(customExercise(entry, 'team')).toBeNull();
    expect(customExercise({ customExercises: { personal: { ...byType['single-choice'], type: 'bogus' } } }, 'personal')).toBeNull();
    expect(customExercise(null, 'personal')).toBeNull();
  });

  it('accepts structured responses in the answer body, within a size bound', () => {
    expect(validAnswerBody({ stage: 'personal', response: { optionId: 'a' } })).toBe(true);
    expect(validAnswerBody({ stage: 'team', response: { word: 'BA' } })).toBe(true);
    expect(validAnswerBody({ stage: 'team', response: { word: 'x'.repeat(9000) } })).toBe(false);
    expect(validAnswerBody({ stage: 'personal', response: { optionId: 'a' }, answers: {} })).toBe(false);
    expect(validAnswerBody({ stage: 'personal', response: 'a' })).toBe(false);
  });

  it("treats Creator Studio's platform scoring model as Platform Settings defaults, not zero points", () => {
    const platform = scoringPolicy({ scoring: { model: 'platform' } });
    expect(platform.personalSolved).toBeGreaterThan(0);
    expect(platform.solvedTeamChallenge).toBeGreaterThan(0);
    expect(scoringPolicy({ scoring: { startingScore: 100, solvedTeamChallenge: 50 } }).personalSolved).toBe(0);
  });
});
