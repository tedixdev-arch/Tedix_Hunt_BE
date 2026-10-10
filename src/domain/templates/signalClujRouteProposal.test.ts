import { describe, expect, it } from 'vitest';
import { isTemplateContent, isTemplateContentSubmittable } from '../creatorTemplates.js';
import { createSignalClujNapocaStarter } from './signalClujNapocaStarter.js';
import { signalClujRouteProposal } from './signalClujRouteProposal.js';

describe('Signal route research proposal', () => {
  it('has seven ordered candidates corresponding to six checkpoints and terminal FinishPoint', () => {
    const { candidates } = signalClujRouteProposal;
    expect(candidates.map((point) => point.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(candidates.filter((point) => point.role === 'normal').map((point) => point.checkpoint))
      .toEqual([1, 2, 3, 4, 5, 6]);
    expect(candidates.map((point) => point.landmark)).toEqual([
      'Piața Unirii — Matthias Corvinus monument', 'Piarist Church — exterior',
      'Babeș-Bolyai University — main building exterior', 'Colegiul Academic — exterior',
      'Saint George statue', 'Reformed Church — exterior', "Tailors' Tower — exterior",
    ]);
    expect(candidates[6]).toMatchObject({ role: 'terminal', terminalRole: 'FinishPoint' });
    expect(candidates[6]).not.toHaveProperty('checkpoint');
  });

  it('records sourced desk research, uncertain arrivals and pending physical verification for every point', () => {
    const sourceIds = new Set(signalClujRouteProposal.sources.map((source) => source.id));
    for (const candidate of signalClujRouteProposal.candidates) {
      expect(candidate.address).toContain('Cluj-Napoca');
      expect(candidate.arrivalArea.length).toBeGreaterThan(20);
      expect(candidate.confidence).toBe('identity-supported-arrival-unverified');
      expect(candidate.physicalVerification).toBe('pending');
      expect(candidate.unresolvedIssues.length).toBeGreaterThan(0);
      expect(candidate.sourceIds.length).toBeGreaterThan(0);
      candidate.sourceIds.forEach((id) => expect(sourceIds.has(id)).toBe(true));
      if (candidate.candidateGps) {
        expect(candidate.candidateGps).toMatchObject({ scope: 'landmark-reference-only', arrivalLocation: false });
        expect(sourceIds.has(candidate.candidateGps.sourceId)).toBe(true);
      }
    }
    expect(signalClujRouteProposal.walkingAssessment.legs.map(({ from, to }) => [from, to]))
      .toEqual([[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]]);
  });

  it('round-trips within the existing draft contract without promoting even edited candidate GPS', () => {
    const draft = createSignalClujNapocaStarter('route-test');
    const reloaded = JSON.parse(JSON.stringify(draft));
    reloaded.routeResearch.proposal.candidates[0].candidateGps = { latitude: 46, longitude: 23 };
    reloaded.version = 2;
    expect(isTemplateContent(reloaded, 'route-test', 2)).toBe(true);
    expect(isTemplateContentSubmittable(reloaded)).toBe(false);
    expect(reloaded.configuration.checkpointPositions).toEqual([]);
    expect(reloaded.configuration).not.toHaveProperty('finishPoint');
    expect(reloaded.checkpoints).toEqual(draft.checkpoints);
    expect(reloaded.scoring).toEqual(draft.scoring);
    expect(reloaded.mission).toEqual(draft.mission);
    expect(draft.routeResearch.proposal).toEqual(signalClujRouteProposal);
    expect(createSignalClujNapocaStarter('another').routeResearch.proposal.candidates[0].candidateGps).toBeNull();
  });
});
