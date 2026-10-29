import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { VERSION } from './constants.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');

async function versionOf(manifest: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(join(ROOT, manifest), 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
    return parsed.version;
  }
  return null;
}

describe('VERSION', () => {
  it('is the root package.json version, which the release tag must match', async () => {
    expect(await versionOf('package.json')).toBe(VERSION);
  });

  it('is every workspace package version too', async () => {
    const packages = ['cli', 'core', 'rpc', 'shared', 'ui', 'web'];
    const versions = await Promise.all(
      packages.map((name) => versionOf(join('packages', name, 'package.json'))),
    );
    expect(versions).toEqual(packages.map(() => VERSION));
  });
});
