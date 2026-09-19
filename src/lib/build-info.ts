import { readFileSync } from 'node:fs';

export const readBuildRevision = (): string | null => {
  try {
    const revision = readFileSync(new URL('../revision.txt', import.meta.url), 'utf8').trim();
    return /^[a-f0-9]{40}$/.test(revision) ? revision : null;
  } catch {
    return null;
  }
};
