import { HuntTemplates } from '../models/HuntTemplate.js';

export interface HuntTemplateSnapshot {
  key: string;
  version: number;
  displayName: string;
  theme: string;
  checkpointNames: string[];
}

export interface HuntTemplateMetadata {
  key: string;
  version: number;
  displayName: string;
  theme: string;
}

const signalClujNapoca: HuntTemplateSnapshot = {
  key: 'signal-cluj-napoca',
  version: 1,
  displayName: 'Signal: Cluj Napoca',
  theme: 'Smart Theme (Signal)',
  checkpointNames: [
    'Matthias Rex Statue',
    'Stone Gate',
    'Clock Tower',
    'Fountain Court',
    'Lantern Lane',
    'North Passage',
    'City Wall · FinishPoint',
  ],
};

const templates = new Map([[signalClujNapoca.key, signalClujNapoca]]);

// Temporary: Hunt draft creation still snapshots this legacy descriptor. Catalog reads below
// deliberately do not use it or fall back to it; Hunt creation will be cut over separately.
export const findHuntTemplate = (key: string): HuntTemplateSnapshot | null => {
  const template = templates.get(key);
  return template ? { ...template, checkpointNames: [...template.checkpointNames] } : null;
};

const toMetadata = ({ key, version, content }: {
  key: string;
  version: number;
  content: unknown;
}): HuntTemplateMetadata => {
  const persisted = content as { displayName: string; theme: string };
  return { key, version, displayName: persisted.displayName, theme: persisted.theme };
};

/** Approved visibility is enforced by the repository query, not by API callers. */
export const listApprovedHuntTemplates = async (): Promise<HuntTemplateMetadata[]> =>
  (await HuntTemplates.listApprovedWithLatestVersion()).map(toMetadata);

export const findApprovedHuntTemplate = async (
  key: string,
): Promise<HuntTemplateMetadata | null> => {
  const template = await HuntTemplates.findApprovedByKeyWithLatestVersion(key);
  return template ? toMetadata(template) : null;
};
