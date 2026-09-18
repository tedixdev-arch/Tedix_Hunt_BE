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

export const findHuntTemplate = (key: string): HuntTemplateSnapshot | null => {
  const template = templates.get(key);
  return template ? { ...template, checkpointNames: [...template.checkpointNames] } : null;
};

export const listHuntTemplates = (): HuntTemplateMetadata[] =>
  [...templates.values()].map(({ checkpointNames: _checkpointNames, ...metadata }) => metadata);
