/**
 * Pilot Solo gameplay (provisional Product Owner defaults; see docs/Participant_Gameplay_Pilot.md).
 * The server holds every answer. Participant DTOs are built from explicit allowlists, never by
 * deleting fields from snapshot JSON, so new secret fields can never leak by accident.
 */
import { record, type ProximityPolicy } from './participantAccess.js';
import { setting } from './platformSettings.js';

export const GAMEPLAY_POLICY_REVISION = 'pilot-solo-2026-11';

/** D1 candidate values from the decisions document; Admins adjust them in Platform Settings (gps.*). */
export const pilotProximityPolicy = (): ProximityPolicy => ({
  maxAgeMs: setting<number>('gps.maxAgeSeconds') * 1000,
  maxAccuracyMeters: setting<number>('gps.maxAccuracyMeters'),
  uncertainty: setting<'center' | 'contained'>('gps.uncertaintyRule'),
});

export interface ScoringPolicy {
  startingScore: number; failedVerifiedAttempt: number; firstAttemptAccuracyBonus: number;
  personalSolved: number; solvedTeamChallenge: number; finishPointPuzzle: number; missionCompletion: number;
  firstAttemptEligible: (checkpoint: number) => boolean; teamEligible: (checkpoint: number) => boolean;
}

const integer = (value: unknown, fallback: number) => Number.isInteger(value) ? value as number : fallback;
const numbers = (value: unknown) => Array.isArray(value) ? value.filter(Number.isInteger) as number[] : null;

/** Authored Template scoring when present. Hint, solution and skip costs are excluded: assistance is unavailable (D4). */
export const scoringPolicy = (snapshot: unknown): ScoringPolicy => {
  const scoring = record(snapshot) && record(snapshot.scoring) ? snapshot.scoring : null;
  if (!scoring) {
    return { startingScore: 0, failedVerifiedAttempt: 0, firstAttemptAccuracyBonus: 0, personalSolved: setting<number>('scoring.defaultPersonalPoints'),
      solvedTeamChallenge: setting<number>('scoring.defaultTeamPoints'), finishPointPuzzle: 0, missionCompletion: 0, firstAttemptEligible: () => false, teamEligible: () => true };
  }
  const firstEligible = numbers(scoring.firstAttemptAccuracyEligibleCheckpoints);
  const teamEligible = numbers(scoring.solvedTeamChallengeEligibleCheckpoints);
  return {
    startingScore: integer(scoring.startingScore, 0),
    failedVerifiedAttempt: setting<boolean>('scoring.applyWrongAnswerPenalty') ? integer(scoring.failedVerifiedAttempt, 0) : 0,
    firstAttemptAccuracyBonus: integer(scoring.firstAttemptAccuracyBonus, 0),
    personalSolved: 0,
    solvedTeamChallenge: integer(scoring.solvedTeamChallenge, 0),
    finishPointPuzzle: integer(scoring.finishPointPuzzle, 0),
    missionCompletion: integer(scoring.missionCompletion, 0),
    firstAttemptEligible: checkpoint => firstEligible ? firstEligible.includes(checkpoint) : true,
    teamEligible: checkpoint => teamEligible ? teamEligible.includes(checkpoint) : true,
  };
};

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const pick = (source: Record<string, any>, keys: readonly string[]) =>
  Object.fromEntries(keys.flatMap(key => text(source[key]) !== undefined ? [[key, source[key]]] : []));

/** Raw authored checkpoint entry for a pinned ordinal (1-based, FinishPoint last). */
export const checkpointEntry = (snapshot: unknown, ordinal: number): Record<string, any> | null => {
  if (!record(snapshot) || !Array.isArray(snapshot.checkpoints)) return null;
  const entry = snapshot.checkpoints[ordinal - 1];
  return record(entry) ? entry : null;
};

export const playableEntry = (entry: Record<string, any> | null): entry is Record<string, any> =>
  !!entry && !Object.hasOwn(entry, 'customExercises') && Array.isArray(entry.answerKeys) && entry.answerKeys.length > 0
  && record(entry.correctAnswers) && entry.answerKeys.every((key: unknown) => typeof key === 'string' && typeof entry.correctAnswers[key] === 'string');

export const hasTeamStage = (entry: Record<string, any>) => typeof entry.teamAnswer === 'string' && entry.teamAnswer.trim().length > 0;

const storyKeys = ['storyStage', 'storyObjective', 'storyProblem', 'storyPlan', 'storyRisk', 'teamInstruction'] as const;

export const missionDto = (snapshot: unknown) => {
  const mission = record(snapshot) && record(snapshot.mission) ? snapshot.mission : {};
  return {
    displayName: record(snapshot) ? text(snapshot.displayName) ?? 'Hunt' : 'Hunt',
    theme: record(snapshot) ? text(snapshot.theme) ?? null : null,
    name: text(mission.name) ?? null, signal: text(mission.signal) ?? null,
    briefing: text(mission.briefing) ?? null, finishLocation: text(mission.finishLocation) ?? null,
  };
};

/** Navigation toward a checkpoint. Fictional puzzle directions come from the previous checkpoint. */
export const navigationDto = (snapshot: unknown, ordinal: number, point: { latitude: number; longitude: number; radiusMeters: number } | null) => {
  const entry = checkpointEntry(snapshot, ordinal) ?? {};
  const previous = ordinal > 1 ? checkpointEntry(snapshot, ordinal - 1) : null;
  const route = previous ? (record(previous.fictionalNavigation) ? previous.fictionalNavigation : previous) : null;
  return {
    location: text(entry.location) ?? null,
    target: point,
    clue: route ? { nextLocation: text(route.nextLocation) ?? null, direction: text(route.direction) ?? null,
      distance: text(route.distance) ?? null, navigationClue: text(route.navigationClue) ?? null,
      navigationMode: text(route.navigationMode) ?? null } : null,
  };
};

export const personalChallengeDto = (entry: Record<string, any>) => ({
  ...pick(entry, ['id', 'kind', 'title', 'label', 'prompt', 'location', ...storyKeys]),
  answerKeys: strings(entry.answerKeys),
  ...(Array.isArray(entry.mistakeSegments) ? { mistakeSegments: entry.mistakeSegments.filter(record)
    .map((s: Record<string, any>) => ({ id: String(s.id), content: String(s.content) })) } : {}),
});

export const teamChallengeDto = (entry: Record<string, any>) => ({
  ...pick(entry, ['teamKind', 'teamPrompt', 'teamRule', 'teamInstruction', 'personalMask']),
  // filter-noise displays the decoded destination; withhold it until the selection is verified.
  ...(entry.teamKind !== 'filter-noise' && text(entry.teamDisplay) ? { teamDisplay: entry.teamDisplay } : {}),
  teamOptions: strings(entry.teamOptions),
  publicContributions: strings(entry.publicContributions),
});

/** Revealed only after the participant solved the personal stage. */
export const personalRevealDto = (entry: Record<string, any>) => ({
  ...pick(entry, ['successText', 'personalContribution', 'personalMask', 'correctedExpression']),
  ...(Array.isArray(entry.mistakeSegments) ? { mistakeContent: entry.mistakeSegments.find((s: any) => record(s) && s.mistake)?.content ?? null } : {}),
});

export const teamRevealDto = (entry: Record<string, any>) => ({
  ...pick(entry, ['storySuccess']),
  teamAnswer: entry.teamKind === 'filter-noise' ? text(entry.teamDisplay) ?? null : text(entry.teamAnswer) ?? null,
});

/** D8 proposal: NFC + outer trim + inner whitespace collapse; case-insensitive unless the content says otherwise. */
export const normalizeAnswer = (value: string, caseSensitive = false) => {
  const normalized = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  return caseSensitive ? normalized : normalized.toUpperCase();
};

export const checkPersonalAnswer = (entry: Record<string, any>, answers: Record<string, unknown>) => {
  const caseSensitive = entry.caseSensitive === true;
  return strings(entry.answerKeys).every(key => typeof answers[key] === 'string'
    && normalizeAnswer(answers[key] as string, caseSensitive) === normalizeAnswer(String(entry.correctAnswers[key]), caseSensitive));
};

export const checkTeamAnswer = (entry: Record<string, any>, answer: string) => {
  const expected = String(entry.teamAnswer);
  // Multi-select answers ("LIAM|ZARA") compare as sets so selection order never matters.
  if (expected.includes('|')) {
    const set = (v: string) => [...new Set(v.split('|').map(p => normalizeAnswer(p)).filter(Boolean))].sort().join('|');
    return set(answer) === set(expected);
  }
  return normalizeAnswer(answer, entry.caseSensitive === true) === normalizeAnswer(expected, entry.caseSensitive === true);
};

export const validAnswerBody = (value: unknown): value is { stage: 'personal' | 'team'; answers?: Record<string, string>; answer?: string } => {
  if (!record(value) || !['personal', 'team'].includes(value.stage)) return false;
  const keys = Object.keys(value);
  if (value.stage === 'personal') {
    return keys.every(k => k === 'stage' || k === 'answers') && record(value.answers)
      && Object.keys(value.answers).length <= 10
      && Object.values(value.answers).every(v => typeof v === 'string' && v.length <= 200);
  }
  return keys.every(k => k === 'stage' || k === 'answer') && typeof value.answer === 'string' && value.answer.length <= 200;
};
