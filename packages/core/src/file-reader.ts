import { readFile } from 'node:fs/promises';

import type { FileReader } from './command-runner.ts';

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** The real file reader. Missing files return null; other errors propagate. */
export const readTextFile: FileReader = async (path) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
};
