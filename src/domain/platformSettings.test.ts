import { afterEach, describe, expect, it } from 'vitest';
import { applySavedSettings, publicSettings, setting, settingsView, validateSetting } from './platformSettings.js';
import { withRadiusDefaults, inheritedRadii } from './checkpointRadius.js';
import { pilotProximityPolicy, scoringPolicy } from './gameplay.js';

const save = (values: Record<string, unknown>) => applySavedSettings(Object.entries(values)
  .map(([key, value]) => ({ key, value, updated_at: new Date(), updated_by_user_id: null })));
afterEach(() => applySavedSettings([]));

describe('Platform Settings', () => {
  it('uses documented defaults until an Admin saves a value', () => {
    expect(setting('checkpoints.defaultRadiusMeters')).toBe(25);
    expect(pilotProximityPolicy()).toEqual({ maxAgeMs: 30_000, maxAccuracyMeters: 20, uncertainty: 'center' });
    expect(settingsView().every(s => !s.customized)).toBe(true);
  });

  it('validates type, range, choices and phone format', () => {
    expect(validateSetting('gps.maxAgeSeconds', 60)).toEqual({ ok: true, value: 60 });
    for (const [key, value] of [['gps.maxAgeSeconds', 4], ['gps.maxAgeSeconds', 1.5], ['gps.uncertaintyRule', 'loose'],
      ['gameplay.organizerCheckInEnabled', 'yes'], ['safety.emergencyNumber', 'dial 112'], ['unknown.key', 1]] as const) {
      expect(validateSetting(key, value)).toEqual({ ok: false });
    }
    expect(validateSetting('safety.emergencyNumber', ' +40 112 ')).toEqual({ ok: true, value: '+40 112' });
  });

  it('applies saved values to GPS policy, scoring and public safety info, ignoring invalid stored rows', () => {
    save({ 'gps.maxAgeSeconds': 60, 'gps.uncertaintyRule': 'contained', 'scoring.applyWrongAnswerPenalty': false,
      'scoring.defaultTeamPoints': 40, 'safety.emergencyNumber': '911', 'gps.maxAccuracyMeters': 9999 });
    expect(pilotProximityPolicy()).toEqual({ maxAgeMs: 60_000, maxAccuracyMeters: 20, uncertainty: 'contained' });
    expect(scoringPolicy({ scoring: { failedVerifiedAttempt: -25 } }).failedVerifiedAttempt).toBe(0);
    expect(scoringPolicy({}).solvedTeamChallenge).toBe(40);
    expect(publicSettings()).toMatchObject({ 'safety.emergencyNumber': '911' });
    expect(Object.keys(publicSettings())).toEqual(['safety.emergencyNumber', 'safety.participantNotice']);
  });

  it('uses the default radius only when a Template is written, never for saved snapshots', () => {
    save({ 'checkpoints.defaultRadiusMeters': 40 });
    const written = withRadiusDefaults({ configuration: { checkpointPositions: [{ checkpointNumber: 1 }, { checkpointNumber: 2, radiusMeters: 10 }], finishPoint: {} } }) as any;
    expect(written.configuration.checkpointPositions.map((p: any) => p.radiusMeters)).toEqual([40, 10]);
    expect(written.configuration.finishPoint.radiusMeters).toBe(40);
    expect(inheritedRadii({ configuration: { checkpointPositions: [{ checkpointNumber: 1 }] } }).checkpointPositions[0].radiusMeters).toBe(25);
  });
});
