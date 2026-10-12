import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isTemplateContent, isTemplateContentSubmittable } from '../creatorTemplates.js';
import { signalClujNapocaV1, SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256 } from './signalClujNapocaV1.js';
import { createSignalClujNapocaStarter } from './signalClujNapocaStarter.js';
import { signalClujRouteProposal } from './signalClujRouteProposal.js';
import { signalOverloadClujNapocaV1 } from './signalOverloadClujNapocaV1.js';
import { createSignalOverloadClujNapocaStarter } from './signalOverloadClujNapocaStarter.js';

const landmarks = ["Tailors' Tower — exterior", 'Reformed Church — exterior', 'Saint George statue',
  'Colegiul Academic — exterior', 'Babeș-Bolyai University — main building exterior',
  'Piarist Church — exterior', 'Piața Unirii — Matthias Corvinus monument'];
const draft = () => createSignalOverloadClujNapocaStarter('overload-review');

describe('Signal Overload v1 and Creator draft', () => {
  it('has a separate stable source identity and uses the existing draft contract', () => {
    expect(signalOverloadClujNapocaV1).toMatchObject({
      key: 'signal-overload-cluj-napoca', version: 1,
      displayName: 'Signal Overload - Cluj Napoca', theme: 'Signal Overload',
    });
    expect(signalOverloadClujNapocaV1.key).not.toBe(signalClujNapocaV1.key);
    expect(isTemplateContent(draft(), 'overload-review', 1)).toBe(true);
    expect(draft().starterSource.key).toBe(signalOverloadClujNapocaV1.key);
    expect(isTemplateContentSubmittable(draft())).toBe(false);
  });

  it('maps unchanged puzzle progression to reversed geography with a terminal FinishPoint', () => {
    const content = draft();
    expect(content.checkpoints.map((entry) => entry.location)).toEqual(landmarks);
    expect(content.checkpoints.map((entry) => entry.kind)).toEqual([
      'hidden-rule', 'find-sabotage', 'square', 'build-key', 'radial', 'identify-signal', 'shared-final-key',
    ]);
    expect(content.checkpoints.map((entry) => entry.storyStage)).toEqual([
      'ACCESS', 'TRACE', 'IDENTIFY', 'REPAIR', 'DECODE', 'LOCATE', 'RESTORE',
    ]);
    expect(content.checkpoints.filter((entry) => entry.role === 'normal').map((entry) => entry.checkpoint))
      .toEqual([1, 2, 3, 4, 5, 6]);
    expect(content.checkpoints.filter((entry) => entry.role === 'terminal')).toHaveLength(1);
    expect(content.checkpoints[6]).not.toHaveProperty('checkpoint');
  });

  it('preserves scoring, mathematical answers, hints, solutions and collaborative mechanics', () => {
    expect(draft().scoring).toEqual(signalClujNapocaV1.scoring);
    draft().checkpoints.forEach((entry, index) => {
      const original = signalClujNapocaV1.checkpoints[index];
      for (const field of ['id', 'kind', 'title', 'label', 'prompt', 'answerKeys', 'correctAnswers',
        'hint', 'solutionIntro', 'solutionSteps', 'teamKind', 'teamAnswer', 'teamOptions']) {
        expect(entry[field as keyof typeof entry]).toEqual(original[field as keyof typeof original]);
      }
      expect(entry.publicContributions).toHaveLength(4);
    });
    expect(draft().checkpoints[3].teamInstruction).toContain('every team contribution once');
    expect(draft().checkpoints[6].teamInstruction).toContain('four digits');
  });

  it('keeps narrative destinations chronological and removes obsolete landmarks', () => {
    draft().checkpoints.forEach((entry, index) => {
      expect(entry.nextDestination).toBe(landmarks[index + 1] ?? 'MISSION COMPLETE');
      for (const field of ['storyProblem', 'storyObjective', 'storyPlan', 'storyRisk', 'storySuccess', 'teamRevelation']) {
        expect(entry[field as keyof typeof entry]).toEqual(expect.any(String));
      }
    });
    const story = JSON.stringify({ mission: draft().mission, checkpoints: draft().checkpoints });
    expect(story).not.toMatch(/Stone Gate|Clock Tower|Fountain Court|Lantern Lane|North Passage|City Wall/i);
    expect(draft().checkpoints[5].storySuccess).toContain('still needs all four Hunters');
    expect(draft().checkpoints[6].storySuccess).toContain('We can hear you');
    expect(draft().mission.briefing).toContain('buildings and monuments contain no game equipment');
  });

  it('keeps walking navigation off and reference coordinates outside saved geography', () => {
    const content = draft();
    expect(content.configuration.checkpointPositions).toEqual([]);
    expect(content.configuration).not.toHaveProperty('finishPoint');
    content.checkpoints.forEach((entry) => {
      expect(entry.navigationMode).toBe('none');
      for (const field of ['direction', 'distance', 'navigationClue', 'nextLocation', 'fictionalNavigation', 'latitude', 'longitude']) {
        expect(entry).not.toHaveProperty(field);
      }
    });
    expect(content.checkpoints[1].teamPrompt).toContain('fictional diagnostic grid');
    expect(content.checkpoints[5].teamInstruction).toContain('WEST is not a walking instruction');
    expect(content.routeResearch).toMatchObject({ status: 'pending', physicalVerification: 'pending', walkingNavigation: 'pending' });
    expect(content.routeResearch.proposal.candidates[0].candidateGps).toMatchObject({ scope: 'landmark-reference-only', arrivalLocation: false });
  });

  it('preserves research identities, sources, uncertainties and original positional context', () => {
    const proposal = draft().routeResearch.proposal;
    expect(proposal.sources).toEqual(signalClujRouteProposal.sources);
    expect(proposal.candidates.map((entry) => entry.landmark)).toEqual(landmarks);
    proposal.candidates.forEach((entry, index) => {
      const original = signalClujRouteProposal.candidates[6 - index];
      for (const field of ['landmark', 'address', 'candidateGps', 'sourceIds', 'arrivalArea', 'confidence', 'physicalVerification', 'unresolvedIssues']) {
        expect(entry[field as keyof typeof entry]).toEqual(original[field as keyof typeof original]);
      }
      expect(entry.order).toBe(index + 1);
      expect(entry.originalProposalPosition.order).toBe(7 - index);
    });
    expect(proposal.walkingAssessment.originalSequenceAssessment).toEqual(signalClujRouteProposal.walkingAssessment);
    expect(proposal.walkingAssessment.legs.every((leg) => leg.proposal.includes('no walking instructions'))).toBe(true);
  });

  it('creates independent snapshots and leaves canonical v1 and legacy starter unchanged', () => {
    const canonical = JSON.stringify(signalClujNapocaV1);
    const research = JSON.stringify(signalClujRouteProposal);
    const legacy = createSignalClujNapocaStarter('old-draft');
    const first = draft();
    const second = createSignalOverloadClujNapocaStarter('second-draft');
    Object.assign(first.checkpoints[0].correctAnswers, { x: 'changed' });
    first.routeResearch.proposal.sources[0].url = 'changed';
    Object.assign(first.scoring, { startingScore: 0 });
    expect(second.scoring.startingScore).toBe(500);
    expect(second.checkpoints[0].correctAnswers).toEqual({ x: '72' });
    expect(JSON.stringify(signalClujNapocaV1)).toBe(canonical);
    expect(JSON.stringify(signalClujRouteProposal)).toBe(research);
    expect(createSignalClujNapocaStarter('old-draft')).toEqual(legacy);
    expect(createHash('sha256').update(JSON.stringify(signalClujNapocaV1.checkpoints)).digest('hex'))
      .toBe(SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256);
    expect(isTemplateContentSubmittable(legacy)).toBe(false);
  });

  it('supports ordinary version editing and submission validation after Creator-authored geography', () => {
    const content = draft();
    const edited = { ...content, version: 2, configuration: { ...content.configuration,
      checkpointPositions: [1, 2, 3, 4, 5, 6].map((checkpointNumber) => ({
        checkpointNumber, name: 'Synthetic fixture', latitude: 0, longitude: 0, radiusMeters: 5,
      })),
      finishPoint: { name: 'Synthetic finish fixture', latitude: 0, longitude: 0, radiusMeters: 5 },
    } };
    expect(isTemplateContent(edited, content.key, 2)).toBe(true);
    expect(isTemplateContentSubmittable(edited)).toBe(true);
    expect(edited.scoring).toEqual(signalClujNapocaV1.scoring);
  });
});
