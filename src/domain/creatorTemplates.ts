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

const hasValidGeographicDraft = (configuration: Record<string, unknown>): boolean => {
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
  return Array.isArray(value.checkpoints) && value.checkpoints.length > 0
    && value.checkpoints.every(isObject);
};

export const isTemplateContentV1 = (value: unknown, key: string): value is TemplateContent =>
  isTemplateContent(value, key, 1);

/**
 * Drafts may progressively collect positions, but a submitted geographic contract must describe
 * every normal checkpoint exactly once. FinishPoint is separate Feature 6 and is never N + 1 here.
 */
export const isTemplateContentSubmittable = (value: unknown): value is TemplateContent => {
  if (!isObject(value) || !isObject(value.configuration)) return false;
  const { normalCheckpointCount: count, checkpointPositions: positions } = value.configuration;
  if (count === undefined && positions === undefined) return true; // Pre-contract Creator content.
  if (!hasValidGeographicDraft(value.configuration) || !Number.isInteger(count)
    || !Array.isArray(positions) || positions.length !== count) return false;
  return true; // Draft validation plus N unique in-range entries implies the complete set 1..N.
};
