import { describe, expect, it } from 'vitest';
import { signalClujNapocaV1 } from './templates/signalClujNapocaV1.js';
import {
  checkPersonalAnswer, checkTeamAnswer, normalizeAnswer, personalChallengeDto, personalRevealDto, playableEntry,
  scoringPolicy, teamChallengeDto, validAnswerBody,
} from './gameplay.js';

const entries = structuredClone(signalClujNapocaV1.checkpoints) as unknown as Record<string, any>[];
const secrets = ['correctAnswers', 'teamAnswer', 'hint', 'solutionIntro', 'solutionSteps', 'mistake', 'correct'];
const containsKey = (value: unknown, key: string): boolean => Array.isArray(value)
  ? value.some(v => containsKey(v, key))
  : !!value && typeof value === 'object' && Object.entries(value).some(([k, v]) => k === key || containsKey(v, key));

describe('pilot gameplay domain', () => {
  it('delivers challenges without any answer, hint or solution field', () => {
    for (const entry of entries) {
      for (const dto of [personalChallengeDto(entry), teamChallengeDto(entry)]) {
        for (const key of secrets) expect(containsKey(dto, key)).toBe(false);
      }
      // Choice-based mechanics necessarily list the right option among the choices; nothing marks it.
      if (!entry.mistakeSegments) expect(JSON.stringify(personalChallengeDto(entry))).not.toContain(`"${entry.correctAnswers.x}"`);
    }
  });

  it('withholds the filter-noise decoded display until the team stage is solved', () => {
    const filter = entries.find(e => e.teamKind === 'filter-noise')!;
    expect(teamChallengeDto(filter)).not.toHaveProperty('teamDisplay');
  });

  it('checks personal answers with normalized, case-insensitive comparison', () => {
    const first = entries[0];
    expect(checkPersonalAnswer(first, { x: ' 72 ' })).toBe(true);
    expect(checkPersonalAnswer(first, { x: '71' })).toBe(false);
    expect(checkPersonalAnswer(first, {})).toBe(false);
    expect(normalizeAnswer('  unlocked  ')).toBe('UNLOCKED');
  });

  it('compares multi-select team answers as sets', () => {
    const filter = entries.find(e => e.teamKind === 'filter-noise')!;
    expect(checkTeamAnswer(filter, 'ZARA|LIAM')).toBe(true);
    expect(checkTeamAnswer(filter, 'LIAM')).toBe(false);
    expect(checkTeamAnswer(entries[0], 'unlocked')).toBe(true);
  });

  it('reveals the earned contribution only through the reveal DTO', () => {
    expect(personalRevealDto(entries[0])).toMatchObject({ personalContribution: 'CN' });
    expect(personalRevealDto(entries[1])).toMatchObject({ mistakeContent: '6x = 12' });
  });

  it('uses authored scoring without assistance penalties, with defaults for unscored content', () => {
    const policy = scoringPolicy(signalClujNapocaV1);
    expect(policy).toMatchObject({ startingScore: 500, failedVerifiedAttempt: -25, firstAttemptAccuracyBonus: 100, solvedTeamChallenge: 50, finishPointPuzzle: 250, missionCompletion: 100 });
    expect(policy.firstAttemptEligible(7)).toBe(false);
    expect(scoringPolicy({})).toMatchObject({ personalSolved: 100, solvedTeamChallenge: 100, startingScore: 0 });
  });

  it('only plays Signal-style content and rejects custom exercises', () => {
    expect(playableEntry(entries[0])).toBe(true);
    expect(playableEntry({ ...entries[0], customExercises: {} })).toBe(false);
  });

  it('validates answer bodies strictly', () => {
    expect(validAnswerBody({ stage: 'personal', answers: { x: '72' } })).toBe(true);
    expect(validAnswerBody({ stage: 'team', answer: 'UNLOCKED' })).toBe(true);
    expect(validAnswerBody({ stage: 'team', answer: 'x', extra: 1 })).toBe(false);
    expect(validAnswerBody({ stage: 'personal', answers: { x: 1 } })).toBe(false);
    expect(validAnswerBody({ stage: 'bonus' })).toBe(false);
  });
});
