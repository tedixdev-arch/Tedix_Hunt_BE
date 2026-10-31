import { record } from './participantAccess.js';

export const DEFAULT_RADIUS_METERS = 25;
// Retain the existing compatibility envelope. Proposed 10–100 m awaits Owner approval.
export const validRadius = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 5 && value <= 500;

/** Write boundary only. Never call while reading historical versions or Hunt snapshots. */
export function withRadiusDefaults<T>(content: T, previous?: unknown): T {
  const copy = structuredClone(content);
  if (!record(copy) || !record(copy.configuration)) return copy;
  const config = copy.configuration;
  const prior = record(previous) && record(previous.configuration) ? previous.configuration : {};
  if (Array.isArray(config.checkpointPositions)) for (const point of config.checkpointPositions) {
    if (!record(point) || point.radiusMeters !== undefined) continue;
    const matches = Array.isArray(prior.checkpointPositions)
      ? prior.checkpointPositions.filter((p: any) => p.checkpointNumber === point.checkpointNumber) : [];
    point.radiusMeters = matches.length === 1 && validRadius(matches[0].radiusMeters)
      ? matches[0].radiusMeters : DEFAULT_RADIUS_METERS;
  }
  if (record(config.finishPoint) && config.finishPoint.radiusMeters === undefined) {
    config.finishPoint.radiusMeters = record(prior.finishPoint) && validRadius(prior.finishPoint.radiusMeters)
      ? prior.finishPoint.radiusMeters : DEFAULT_RADIUS_METERS;
  }
  return copy;
}

export interface CheckpointRadii {
  checkpointPositions: { checkpointNumber: number; radiusMeters: number }[];
  finishPoint?: { radiusMeters: number };
}
/** Only saved geographic points get radii; canonical Signal without GPS stays without GPS. */
export function inheritedRadii(snapshot: unknown): CheckpointRadii {
  const config = record(snapshot) && record(snapshot.configuration) ? snapshot.configuration : {};
  return {
    checkpointPositions: (Array.isArray(config.checkpointPositions) ? config.checkpointPositions : [])
      .map((p: any) => ({ checkpointNumber: p.checkpointNumber, radiusMeters: p.radiusMeters ?? DEFAULT_RADIUS_METERS })),
    ...(record(config.finishPoint) ? { finishPoint: { radiusMeters: config.finishPoint.radiusMeters ?? DEFAULT_RADIUS_METERS } } : {}),
  };
}

export const validRadiusPatch = (value: unknown): value is Partial<CheckpointRadii> => {
  if (!record(value) || !Object.keys(value).length || Object.keys(value).some(k => !['checkpointPositions','finishPoint'].includes(k))) return false;
  if (value.finishPoint !== undefined && (!record(value.finishPoint)
    || Object.keys(value.finishPoint).join(',') !== 'radiusMeters' || !Number.isInteger(value.finishPoint.radiusMeters)
    || !validRadius(value.finishPoint.radiusMeters))) return false;
  if (value.checkpointPositions !== undefined) {
    if (!Array.isArray(value.checkpointPositions) || !value.checkpointPositions.length || value.checkpointPositions.length > 20) return false;
    const seen = new Set<number>();
    for (const p of value.checkpointPositions) {
      if (!record(p) || Object.keys(p).sort().join(',') !== 'checkpointNumber,radiusMeters'
        || !Number.isInteger(p.checkpointNumber) || p.checkpointNumber < 1 || p.checkpointNumber > 20
        || seen.has(p.checkpointNumber) || !validRadius(p.radiusMeters)) return false;
      seen.add(p.checkpointNumber);
    }
  }
  return true;
};
