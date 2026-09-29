import { HuntTemplates } from '../models/HuntTemplate.js';

export interface HuntTemplateMetadata {
  key: string;
  version: number;
  displayName: string;
  theme: string;
}

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
