import {
  signalOverloadClujNapocaV1, SIGNAL_OVERLOAD_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256,
} from './signalOverloadClujNapocaV1.js';

/** A fresh ordinary Creator draft; key conflicts use the existing persistence behavior. */
export const createSignalOverloadClujNapocaStarter = (key: string) => {
  const source = structuredClone(signalOverloadClujNapocaV1);
  return {
    ...source, key, version: 1,
    starterSource: {
      key: source.key, version: source.version,
      checkpointsSha256: SIGNAL_OVERLOAD_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256,
    },
  };
};
