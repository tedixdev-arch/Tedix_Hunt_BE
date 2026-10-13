import { signalClujNapocaV1 } from './signalClujNapocaV1.js';
import { signalOverloadClujNapocaV1 } from './signalOverloadClujNapocaV1.js';

export interface StarterCatalogItem {
  key: string;
  displayName: string;
  description: string;
  /** Verified starter creation/registration time, never a Creator copy's time. */
  createdAt: string | null;
  creationPath: string;
}

// Neither source definition nor its starter route records a creation timestamp.
// Platform installation and Creator draft timestamps are different events.
// See docs/creator-starter-catalog.md for provenance and verification requirements.
const starters: readonly Readonly<StarterCatalogItem>[] = [
  { source: signalClujNapocaV1, description: signalClujNapocaV1.mission.briefing },
  { source: signalOverloadClujNapocaV1, description: 'Diagnose a fictional network overload, repair the links and unlock the final transmitter together in Cluj Napoca.' },
].map(({ source, description }) => Object.freeze({
  key: source.key,
  displayName: source.displayName,
  description,
  createdAt: null,
  creationPath: `/api/creator/templates/starters/${source.key}`,
}));

/** Known dates descending, unknown dates last, then locale-independent key order. */
export const orderStarterCatalog = (items: readonly Readonly<StarterCatalogItem>[]): StarterCatalogItem[] =>
  items.map((item) => ({ ...item })).sort((a, b) => {
    if (a.createdAt !== null && b.createdAt === null) return -1;
    if (a.createdAt === null && b.createdAt !== null) return 1;
    const dateOrder = a.createdAt !== null && b.createdAt !== null
      ? Date.parse(b.createdAt) - Date.parse(a.createdAt) : 0;
    return dateOrder || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });

export const listStarterCatalog = (): StarterCatalogItem[] => orderStarterCatalog(starters);
