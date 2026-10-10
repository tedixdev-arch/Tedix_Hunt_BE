import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isTemplateContent, isTemplateContentSubmittable } from '../creatorTemplates.js';
import { createSignalClujNapocaStarter } from './signalClujNapocaStarter.js';
import { SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256, signalClujNapocaV1 } from './signalClujNapocaV1.js';

describe('Signal Cluj Creator starter factory', () => {
  it('creates six numbered normal entries and a separate unnumbered terminal with full gameplay', () => {
    const draft = createSignalClujNapocaStarter('my-signal');
    expect(isTemplateContent(draft, 'my-signal', 1)).toBe(true);
    expect(draft.configuration.normalCheckpointCount).toBe(6);
    expect(draft.checkpoints.filter((entry) => entry.role === 'normal').map((entry) => entry.checkpoint))
      .toEqual([1, 2, 3, 4, 5, 6]);
    const terminal = draft.checkpoints.filter((entry) => entry.role === 'terminal');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).not.toHaveProperty('checkpoint');
    expect(terminal[0]).not.toHaveProperty('checkpointNumber');
    expect(terminal[0]).toMatchObject({ kind: 'shared-final-key', teamKind: 'shared-final-key', teamAnswer: '2397' });
  });

  it('preserves every canonical story, puzzle, answer, hint, challenge and scoring field', () => {
    const draft = createSignalClujNapocaStarter('my-signal');
    expect(draft.mission).toEqual(signalClujNapocaV1.mission);
    expect(draft.scoring).toEqual(signalClujNapocaV1.scoring);
    expect(draft.configuration).toMatchObject(signalClujNapocaV1.configuration);
    const reconstructed = draft.checkpoints.map((entry, index) => {
      const { role, fictionalNavigation, navigationMode, ...gameplay } = entry;
      const { scope, ...puzzleNavigation } = fictionalNavigation;
      return { ...gameplay, ...puzzleNavigation, checkpoint: index + 1 };
    });
    // Whole-object equality catches loss of arbitrary puzzle fields, not just known answer fields.
    expect(reconstructed).toEqual(signalClujNapocaV1.checkpoints);
    expect(draft.starterSource).toEqual({
      key: 'signal-cluj-napoca', version: 1, checkpointsSha256: SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256,
    });
  });

  it('isolates fictional directions and distances and supplies no unverified geography', () => {
    const draft = createSignalClujNapocaStarter('my-signal');
    expect(draft.routeResearch).toMatchObject({
      status: 'pending', physicalVerification: 'pending', walkingNavigation: 'pending',
    });
    expect(draft.configuration.checkpointPositions).toEqual([]);
    expect(draft.configuration).not.toHaveProperty('finishPoint');
    draft.checkpoints.forEach((entry, index) => {
      expect(entry.navigationMode).toBe('none');
      for (const field of ['direction', 'distance', 'navigationClue', 'nextLocation', 'latitude', 'longitude', 'radiusMeters']) {
        expect(entry).not.toHaveProperty(field);
      }
      expect(entry.fictionalNavigation).toMatchObject({
        scope: 'puzzle-only', distance: signalClujNapocaV1.checkpoints[index].distance,
        navigationClue: signalClujNapocaV1.checkpoints[index].navigationClue,
      });
    });
    expect(isTemplateContentSubmittable(draft)).toBe(false);
  });

  it('returns independent JSON snapshots without changing canonical v1', () => {
    const before = JSON.stringify(signalClujNapocaV1);
    const first = createSignalClujNapocaStarter('first-signal');
    const second = createSignalClujNapocaStarter('second-signal');
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.scoring).not.toBe(second.scoring);
    expect(first.checkpoints[0].correctAnswers).not.toBe(second.checkpoints[0].correctAnswers);
    Object.assign(first.scoring, { startingScore: 0 });
    Object.assign(first.checkpoints[0].correctAnswers, { x: 'changed' });
    expect(second.scoring.startingScore).toBe(500);
    expect(second.checkpoints[0].correctAnswers).toEqual(signalClujNapocaV1.checkpoints[0].correctAnswers);
    expect(JSON.stringify(signalClujNapocaV1)).toBe(before);
    expect(createHash('sha256').update(JSON.stringify(signalClujNapocaV1.checkpoints)).digest('hex'))
      .toBe(SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256);
  });

  it('uses ordinary version validation and becomes submittable after geography is authored', () => {
    const draft = createSignalClujNapocaStarter('my-signal');
    const edited = {
      ...draft, version: 2,
      configuration: {
        ...draft.configuration,
        // Synthetic contract fixtures only; these are not researched Cluj locations.
        checkpointPositions: [1, 2, 3, 4, 5, 6].map((checkpointNumber) => ({
          checkpointNumber, name: `Test point ${checkpointNumber}`, latitude: 0, longitude: 0, radiusMeters: 5,
        })),
        finishPoint: { name: 'Test FinishPoint', latitude: 0, longitude: 0, radiusMeters: 5 },
      },
    };
    expect(isTemplateContent(edited, draft.key, 2)).toBe(true);
    expect(isTemplateContentSubmittable(edited)).toBe(true);
    expect(edited.scoring).toEqual(signalClujNapocaV1.scoring);
  });
});
