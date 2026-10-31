/** Access foundation only. Product has not approved D1/D6; no runtime GPS grants. */
export class ParticipantAccessError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export const fail = (status: number, code: string): never => { throw new ParticipantAccessError(status, code); };
export const record = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export interface GpsObservation { latitude: number; longitude: number; accuracyMeters: number; observedAt: string }
export const validObservation = (value: unknown): value is GpsObservation => {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'accuracyMeters,latitude,longitude,observedAt') return false;
  return finite(value.latitude) && Math.abs(value.latitude) <= 90 && finite(value.longitude) && Math.abs(value.longitude) <= 180 &&
    finite(value.accuracyMeters) && value.accuracyMeters >= 0 && typeof value.observedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt) &&
    Number.isFinite(Date.parse(value.observedAt)) && new Date(value.observedAt).toISOString() === value.observedAt;
};
/** Haversine great-circle distance, IUGG mean Earth radius 6,371,008.8 m. */
export const distanceMeters = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number => {
  const radians = (v: number) => v * Math.PI / 180;
  const sinLat = Math.sin(radians(b.latitude - a.latitude) / 2);
  const sinLon = Math.sin(radians(b.longitude - a.longitude) / 2);
  const h = sinLat ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * sinLon ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
};
// Explicit input for policy review/testing, NOT runtime configuration or an approval switch.
export interface ProximityPolicy { maxAgeMs: number; maxAccuracyMeters: number; uncertainty: 'center' | 'contained' }
export const evaluateProximity = (observation: GpsObservation, point: { latitude: number; longitude: number; radiusMeters: number },
  policy: ProximityPolicy, now: number): 'verified' | 'invalid_observation' | 'stale' | 'inaccurate' | 'outside_radius' => {
  if (!validObservation(observation) || !finite(point.latitude) || Math.abs(point.latitude) > 90 ||
    !finite(point.longitude) || Math.abs(point.longitude) > 180 || !finite(point.radiusMeters) || point.radiusMeters <= 0 ||
    !finite(now) || !finite(policy.maxAgeMs) || policy.maxAgeMs <= 0 || !finite(policy.maxAccuracyMeters) || policy.maxAccuracyMeters <= 0 ||
    !['center','contained'].includes(policy.uncertainty)) return 'invalid_observation';
  const age = now - Date.parse(observation.observedAt);
  if (age < 0 || age > policy.maxAgeMs) return 'stale';
  if (observation.accuracyMeters > policy.maxAccuracyMeters) return 'inaccurate';
  const distance = distanceMeters(observation, point);
  return distance + (policy.uncertainty === 'contained' ? observation.accuracyMeters : 0) <= point.radiusMeters ? 'verified' : 'outside_radius';
};
export interface SnapshotCheckpoint { ordinal: number; kind: 'regular' | 'finish'; point: { latitude: number; longitude: number; radiusMeters: number } | null }
/** Only pinned Hunt JSON; never a current Template or client checkpoint index. Missing GPS stays missing. */
export const snapshotCheckpoints = (snapshot: unknown, key: string, version: number): SnapshotCheckpoint[] => {
  if (!record(snapshot) || snapshot.key !== key || snapshot.version !== version || !Array.isArray(snapshot.checkpoints) ||
    snapshot.checkpoints.length < 1 || snapshot.checkpoints.length > 101) return fail(409, 'snapshot_unavailable');
  const checkpoints = snapshot.checkpoints;
  const config = record(snapshot.configuration) ? snapshot.configuration : {};
  const legacySignal = key === 'signal-cluj-napoca' && version === 1 && checkpoints.length === 7;
  const positions = Array.isArray(config.checkpointPositions) ? config.checkpointPositions : [];
  const result = checkpoints.map((entry: unknown, index: number): SnapshotCheckpoint => {
    if (!record(entry)) return fail(409, 'snapshot_unavailable');
    const terminal = entry.role === 'terminal' || (legacySignal && index === 6 && entry.checkpoint === 7);
    if (terminal ? index !== checkpoints.length - 1 : entry.checkpoint !== index + 1 || (entry.role !== undefined && entry.role !== 'normal')) {
      return fail(409, 'snapshot_unavailable');
    }
    const candidates = terminal ? [config.finishPoint] : positions.filter((p: unknown) => record(p) && p.checkpointNumber === entry.checkpoint);
    const p = candidates.length === 1 ? candidates[0] : null;
    const point = record(p) && finite(p.latitude) && Math.abs(p.latitude) <= 90 && finite(p.longitude) && Math.abs(p.longitude) <= 180 &&
      finite(p.radiusMeters) && p.radiusMeters > 0 ? { latitude: p.latitude, longitude: p.longitude, radiusMeters: p.radiusMeters } : null;
    return { ordinal: index + 1, kind: terminal ? 'finish' : 'regular', point };
  });
  if (result.at(-1)?.kind !== 'finish' || result.filter(c => c.kind === 'finish').length !== 1) return fail(409, 'snapshot_unavailable');
  return result;
};
