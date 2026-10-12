import { signalClujRouteProposal } from './signalClujRouteProposal.js';

/** Reorder research identities only. No pin, arrival area or walking leg is verified. */
export const signalOverloadClujRouteProposal = (() => {
  const source = structuredClone(signalClujRouteProposal);
  return {
    ...source,
    candidates: source.candidates.slice().reverse().map((candidate, index) => {
      const { checkpoint, terminalRole, role, order, ...research } = candidate;
      return {
        ...research,
        // Original research stays attributable, including positional wording in unresolved issues.
        originalProposalPosition: { order, role, ...(checkpoint ? { checkpoint } : { terminalRole }) },
        order: index + 1,
        ...(index === 6 ? { role: 'terminal', terminalRole: 'FinishPoint' }
          : { role: 'normal', checkpoint: index + 1 }),
      };
    }),
    walkingAssessment: {
      ...source.walkingAssessment,
      orderRationale: 'Requested reverse landmark sequence only; no reverse walking instructions have been surveyed.',
      // Preserve old directional evidence separately; it must not become reverse-route guidance.
      originalSequenceAssessment: source.walkingAssessment,
      legs: Array.from({ length: 6 }, (_, index) => ({
        from: index + 1, to: index + 2,
        proposal: 'Pending geographic and physical verification; no walking instructions supplied.',
        unresolved: index === 1
          ? 'Reformed Church / Saint George statue: measure arrival-area separation and test non-overlapping radii.'
          : 'Survey legal crossings, approach, step-free access, gathering capacity and current restrictions.',
      })),
      fieldChecklist: [
        'Walk the entire reversed sequence in daylight.',
        'Record legal crossings and step-free alternatives.',
        'Measure and photograph public arrival boundaries and GPS accuracy.',
        'Measure checkpoint 2/3 separation and trial non-overlapping discovery radii.',
        'Verify the tower starting area and the monument FinishPoint approach.',
        'Confirm group capacity, access restrictions, construction and event impacts.',
      ],
    },
  };
})();
