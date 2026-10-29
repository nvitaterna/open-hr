/**
 * The one-time setup token (decision 0008). The package's postinst, or
 * `ohr-web setup-token`, writes it to a file only the ohr user can read;
 * creating the admin account deletes it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';

const TOKEN_BYTES = 32;
const FILE_MODE = 0o600;

function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Writes a fresh token to `path`, replacing any old one, and returns it. */
export async function writeSetupToken(path: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await writeFile(path, `${token}\n`, { mode: FILE_MODE });
  return token;
}

/** True when `candidate` is the token in the file. False when there is no file. */
export async function checkSetupToken(path: string, candidate: string): Promise<boolean> {
  let stored: string;
  try {
    stored = (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
  // Comparing digests keeps the comparison constant-time whatever the lengths.
  return stored !== '' && timingSafeEqual(digest(stored), digest(candidate));
}

/** Removes the token once it has been used. */
export async function removeSetupToken(path: string): Promise<void> {
  await rm(path, { force: true });
}
