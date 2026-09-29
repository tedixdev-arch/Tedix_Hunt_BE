export type TemplateContent = Record<string, unknown> & { key: string; version: number };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const normalizeTemplateKey = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) && key.length <= 100 ? key : null;
};

export const isTemplateContent = (
  value: unknown,
  key: string,
  expectedVersion: number,
): value is TemplateContent => {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return false;
  if (!isObject(value) || value.key !== key || value.version !== expectedVersion) return false;
  if (typeof value.displayName !== 'string' || value.displayName.trim() === '') return false;
  if (typeof value.theme !== 'string' || value.theme.trim() === '') return false;
  if (!isObject(value.mission) || Object.keys(value.mission).length === 0) return false;
  if (!isObject(value.configuration) || Object.keys(value.configuration).length === 0) return false;
  if (!isObject(value.scoring) || Object.keys(value.scoring).length === 0) return false;
  return Array.isArray(value.checkpoints) && value.checkpoints.length > 0
    && value.checkpoints.every(isObject);
};

export const isTemplateContentV1 = (value: unknown, key: string): value is TemplateContent =>
  isTemplateContent(value, key, 1);
