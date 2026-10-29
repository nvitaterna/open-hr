import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkSetupToken, removeSetupToken, writeSetupToken } from './setup-token.ts';

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ohr-token-'));
  path = join(directory, 'setup-token');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('setup token', () => {
  it('writes a long random token only its owner can read', async () => {
    const token = await writeSetupToken(path);
    expect(token).toMatch(TOKEN);
    expect((await readFile(path, 'utf8')).trim()).toBe(token);
    expect((await stat(path)).mode % 0o1000).toBe(0o600);
    expect(await writeSetupToken(path)).not.toBe(token);
  });

  it('accepts only the current token, and nothing once it is removed', async () => {
    const token = await writeSetupToken(path);
    await expect(checkSetupToken(path, token)).resolves.toBe(true);
    await expect(checkSetupToken(path, `${token}x`)).resolves.toBe(false);
    await expect(checkSetupToken(path, '')).resolves.toBe(false);
    await removeSetupToken(path);
    await expect(checkSetupToken(path, token)).resolves.toBe(false);
  });
});
