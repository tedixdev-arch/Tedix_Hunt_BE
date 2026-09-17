import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Migration } from './types.js';

export const discoverMigrations = async (directory: string): Promise<Migration[]> => {
  const filenames = (await readdir(directory))
    .filter((filename) => /^\d{3}_[a-z0-9_]+\.js$/.test(filename))
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    filenames.map(async (filename) => {
      const module = (await import(pathToFileURL(`${directory}/${filename}`).href)) as {
        default?: Migration;
      };
      if (!module.default) throw new Error(`Migration ${filename} has no default export.`);
      return module.default;
    }),
  );
};

export type { Migration } from './types.js';
