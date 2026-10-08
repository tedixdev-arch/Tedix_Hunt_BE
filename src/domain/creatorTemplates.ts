export type TemplateContent = Record<string, unknown> & { key: string; version: number };

const MIN_NORMAL_CHECKPOINTS = 1;
const MAX_NORMAL_CHECKPOINTS = 20;
const MIN_RADIUS_METERS = 5;
const MAX_RADIUS_METERS = 500;
const MAX_CHECKPOINT_NAME_LENGTH = 100;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

// A supplied FinishPoint is one complete object. Never default or normalize persisted values.
const hasValidFinishPoint = (value: unknown): boolean =>
  isObject(value) && Object.keys(value).every((key) =>
    ['name', 'latitude', 'longitude', 'radiusMeters'].includes(key))
  && typeof value.name === 'string' && value.name.trim().length > 0
  && value.name.length <= MAX_CHECKPOINT_NAME_LENGTH
  && isFiniteNumber(value.latitude) && value.latitude >= -90 && value.latitude <= 90
  && isFiniteNumber(value.longitude) && value.longitude >= -180 && value.longitude <= 180
  && Number.isInteger(value.radiusMeters) && (value.radiusMeters as number) >= MIN_RADIUS_METERS
  && (value.radiusMeters as number) <= MAX_RADIUS_METERS;

const hasValidGeographicDraft = (configuration: Record<string, unknown>): boolean => {
  if (configuration.finishPoint !== undefined && !hasValidFinishPoint(configuration.finishPoint)) {
    return false;
  }
  const count = configuration.normalCheckpointCount;
  const positions = configuration.checkpointPositions;
  const usesGeographicContract = count !== undefined || positions !== undefined;
  if (!usesGeographicContract) return true; // Legacy immutable content remains readable/submittable.
  if (!Number.isInteger(count) || (count as number) < MIN_NORMAL_CHECKPOINTS
    || (count as number) > MAX_NORMAL_CHECKPOINTS) return false;
  if (positions === undefined) return true;
  if (!Array.isArray(positions)) return false;

  const checkpointNumbers = new Set<number>();
  return positions.every((position) => {
    if (!isObject(position)) return false;
    const number = position.checkpointNumber;
    if (!Number.isInteger(number) || (number as number) < 1 || (number as number) > (count as number)
      || checkpointNumbers.has(number as number)) return false;
    checkpointNumbers.add(number as number);
    return typeof position.name === 'string' && position.name.trim().length > 0
      && position.name.length <= MAX_CHECKPOINT_NAME_LENGTH
      && isFiniteNumber(position.latitude) && position.latitude >= -90 && position.latitude <= 90
      && isFiniteNumber(position.longitude) && position.longitude >= -180 && position.longitude <= 180
      && isFiniteNumber(position.radiusMeters) && position.radiusMeters >= MIN_RADIUS_METERS
      && position.radiusMeters <= MAX_RADIUS_METERS;
  });
};

// The existing flat checkpoint fields are shared by normal and terminal gameplay.
// Omitted challenge/navigation fields remain optional, as in the original Creator contract.
const hasValidCheckpointGameplay = (checkpoint: Record<string, unknown>): boolean => {
  const supportedTypes: Record<string, readonly string[]> = {
    kind: ['hidden-rule', 'find-sabotage', 'square', 'build-key', 'radial', 'identify-signal', 'shared-final-key'],
    teamKind: ['scrambled-word', 'distributed-information', 'hypothesis', 'assemble-machine', 'clue-synthesis', 'filter-noise', 'shared-final-key'],
    navigationMode: ['compass', 'landmark', 'decoded-route', 'signal-strength', 'none'],
  };
  return Object.entries(supportedTypes).every(([field, types]) =>
    checkpoint[field] === undefined || (typeof checkpoint[field] === 'string'
      && types.includes(checkpoint[field] as string)));
};

const hasValidGameplayDraft = (checkpoints: unknown, validateTypes = true): checkpoints is Record<string, unknown>[] => {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0 || !checkpoints.every(isObject)) return false;
  const terminal = checkpoints.filter((checkpoint) => checkpoint.role === 'terminal');
  if (terminal.length > 1) return false;
  return checkpoints.every((checkpoint) =>
    (checkpoint.role === undefined || checkpoint.role === 'normal' || checkpoint.role === 'terminal')
    && (checkpoint.role !== 'terminal' || (checkpoint.checkpoint === undefined && checkpoint.checkpointNumber === undefined))
    && (!validateTypes || hasValidCheckpointGameplay(checkpoint)));
};

// Legacy non-geographic JSON had no typed gameplay validation; explicit roles opt into it.
const usesGameplayContract = (value: Record<string, unknown>): boolean => {
  const configuration = value.configuration as Record<string, unknown>;
  return configuration.normalCheckpointCount !== undefined || configuration.checkpointPositions !== undefined
    || (Array.isArray(value.checkpoints) && value.checkpoints.some((checkpoint) =>
      isObject(checkpoint) && checkpoint.role !== undefined));
};

export const normalizeTemplateKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && key.length <= 100 ? key : null;
};

export const isTemplateContent = (
  value: unknown,
  key: string,
  expectedVersion: number,
): value is TemplateContent => {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return false;
  if (!isObject(value) || value.key !== key || value.version !== expectedVersion) return false;
  if (typeof value.displayName !== 'string' || value.displayName.trim() === '') return false;
  if (typeof value.theme !== 'string' || value.theme.trim() === '') return false;
  if (!isObject(value.mission) || Object.keys(value.mission).length === 0) return false;
  if (!isObject(value.configuration) || Object.keys(value.configuration).length === 0
    || !hasValidGeographicDraft(value.configuration)) return false;
  if (!isObject(value.scoring) || Object.keys(value.scoring).length === 0) return false;
  return hasValidGameplayDraft(value.checkpoints, usesGameplayContract(value));
};

export const isTemplateContentV1 = (value: unknown, key: string): value is TemplateContent =>
  isTemplateContent(value, key, 1);

/**
 * Drafts may progressively collect positions, but a submitted geographic contract must describe
 * every normal checkpoint exactly once and one FinishPoint. Feature 6 never contributes to N.
 */
export const isTemplateContentSubmittable = (value: unknown): value is TemplateContent => {
  if (!isObject(value) || !isObject(value.configuration)) return false;
  const { normalCheckpointCount: count, checkpointPositions: positions } = value.configuration;
  if (!hasValidGeographicDraft(value.configuration)
    || !hasValidGameplayDraft(value.checkpoints, usesGameplayContract(value))) return false;
  if (count === undefined && positions === undefined) return true; // Pre-contract Creator content.
  if (!hasValidFinishPoint(value.configuration.finishPoint) || !Number.isInteger(count)
    || !Array.isArray(positions) || positions.length !== count) return false;
  // Enforce new authoring only at submission; never infer roles or rewrite old versions/snapshots.
  return value.checkpoints.filter((checkpoint) => checkpoint.role === 'terminal').length === 1;
};
