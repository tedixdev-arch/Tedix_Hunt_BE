import { signalClujNapocaV1 } from './templates/signalClujNapocaV1.js';

// Signal v1 is the canonical vocabulary. Derive it without modifying immutable content.
export const checkpointGameplayTypes: Record<string, readonly string[]> = {
  kind: [...new Set(signalClujNapocaV1.checkpoints.map((checkpoint) => checkpoint.kind))],
  teamKind: [...new Set(signalClujNapocaV1.checkpoints.map((checkpoint) => checkpoint.teamKind))],
  navigationMode: [...new Set(signalClujNapocaV1.checkpoints.map((checkpoint) => checkpoint.navigationMode))],
};
