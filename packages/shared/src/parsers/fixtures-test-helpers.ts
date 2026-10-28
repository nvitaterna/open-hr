/** Loads parser fixtures for tests. Not part of the package API. */

import { readFileSync } from 'node:fs';

const FIXTURES = new URL('../../fixtures/', import.meta.url);

/** Reads a fixture by its path inside packages/shared/fixtures, such as "example-shr1/lsblk.json". */
export function readFixture(path: string): string {
  return readFileSync(new URL(path, FIXTURES), 'utf8');
}
