import {
  SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256,
  signalClujNapocaV1,
} from './signalClujNapocaV1.js';
import { signalClujRouteProposal } from './signalClujRouteProposal.js';

/** A fresh authoring copy only; never persist changes to the canonical platform identity. */
export const createSignalClujNapocaStarter = (key: string) => {
  const source = structuredClone(signalClujNapocaV1);
  return {
    ...source,
    key,
    version: 1,
    starterSource: {
      key: source.key,
      version: source.version,
      checkpointsSha256: SIGNAL_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256,
    },
    routeResearch: {
      proposal: structuredClone(signalClujRouteProposal),
      status: 'pending',
      physicalVerification: 'pending',
      walkingNavigation: 'pending',
      note: 'Locations, directions, distances and safety language in the story are fictional puzzle content. Research the Cluj Napoca route and physically verify it before supplying real walking navigation. No GPS positions, walking distances or safety certification have been verified.',
    },
    configuration: {
      ...source.configuration,
      normalCheckpointCount: 6,
      checkpointPositions: [],
      // finishPoint must be complete when supplied. Omit it until researched, never invent GPS.
    },
    checkpoints: source.checkpoints.map((entry) => {
      const { checkpoint, direction, distance, navigationClue, nextLocation, navigationMode, ...gameplay } = entry;
      return {
        ...gameplay,
        ...(checkpoint === 7 ? { role: 'terminal' as const } : { role: 'normal' as const, checkpoint }),
        // Keep all challenge/story fields in the shared gameplay contract; walking navigation is off.
        navigationMode: 'none',
        // Isolate the fictional route instructions so they cannot masquerade as walking navigation.
        fictionalNavigation: { scope: 'puzzle-only', direction, distance, navigationClue, nextLocation, navigationMode },
      };
    }),
  };
};
