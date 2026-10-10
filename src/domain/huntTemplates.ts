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

export interface TemplateGeographicPoint {
  name?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
}

export interface HuntTemplateGeography {
  key: string;
  version: number;
  configuration: {
    normalCheckpointCount?: number;
    checkpointPositions?: (TemplateGeographicPoint & { checkpointNumber?: number })[];
    finishPoint?: TemplateGeographicPoint;
  };
}

export class HuntTemplateGeographyUnavailableError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Allowlist at every level: extension fields can contain unpublished gameplay or answers. */
const projectPoint = (value: unknown, checkpoint = false): TemplateGeographicPoint => {
  if (!isRecord(value)) throw new HuntTemplateGeographyUnavailableError();
  const fields = checkpoint
    ? ['checkpointNumber', 'name', 'latitude', 'longitude', 'radiusMeters']
    : ['name', 'latitude', 'longitude', 'radiusMeters'];
  const point: Record<string, string | number> = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    const saved = value[field];
    if (field === 'name' ? typeof saved !== 'string'
      : typeof saved !== 'number' || !Number.isFinite(saved)) {
      throw new HuntTemplateGeographyUnavailableError();
    }
    point[field] = saved as string | number;
  }
  return point;
};

/** Resolve anew on every read using the catalog/selection authority; never accept a version override. */
export const findApprovedHuntTemplateGeography = async (
  key: string,
): Promise<HuntTemplateGeography | null> => {
  const template = await HuntTemplates.findApprovedByKeyWithLatestVersion(key);
  if (!template) return null;
  if (!isRecord(template.content)) throw new HuntTemplateGeographyUnavailableError();
  const configuration: HuntTemplateGeography['configuration'] = {};
  const saved = template.content.configuration;
  // Pre-geography versions still identify the approved artifact, with no invented fields.
  if (saved === undefined) return { key: template.key, version: template.version, configuration };
  if (!isRecord(saved)) throw new HuntTemplateGeographyUnavailableError();
  if (Object.hasOwn(saved, 'normalCheckpointCount')) {
    if (!Number.isInteger(saved.normalCheckpointCount)) throw new HuntTemplateGeographyUnavailableError();
    configuration.normalCheckpointCount = saved.normalCheckpointCount as number;
  }
  if (Object.hasOwn(saved, 'checkpointPositions')) {
    if (!Array.isArray(saved.checkpointPositions)) throw new HuntTemplateGeographyUnavailableError();
    configuration.checkpointPositions = saved.checkpointPositions.map((point) => projectPoint(point, true));
  }
  if (Object.hasOwn(saved, 'finishPoint')) configuration.finishPoint = projectPoint(saved.finishPoint);
  return { key: template.key, version: template.version, configuration };
};
