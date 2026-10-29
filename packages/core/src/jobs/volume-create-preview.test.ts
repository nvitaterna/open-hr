import { describe, expect, it } from 'vitest';

import { formatSize } from '@ohr/shared/sizes';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';
import type { VolumeCreateRequest } from '@ohr/shared/volume-create-request';

import { exampleShr1Answers, exampleShr1Files, fakeRunner } from '../fake-system-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import {
  previewVolumeCreate,
  recheckVolumeCreate,
  volumeSizeBytes,
} from './volume-create-preview.ts';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const REQUEST: VolumeCreateRequest = {
  poolId: 'p1',
  name: 'media',
  filesystem: 'ext4',
  size: { kind: 'all-free' },
};

/** The worked example with `freeBytes` left in its volume group. */
async function example(freeBytes: number): Promise<SystemSnapshot> {
  const snapshot = await readSystemState({
    run: fakeRunner(exampleShr1Answers()).run,
    readFile: exampleShr1Files(),
    includeSmart: false,
  });
  return {
    ...snapshot,
    volumeGroups: snapshot.volumeGroups.map((group) => ({ ...group, freeBytes })),
  };
}

function reasons(result: ReturnType<typeof previewVolumeCreate>): readonly string[] {
  if (result.ok) {
    return [];
  }
  return result.reasons;
}

describe('previewVolumeCreate', () => {
  it('builds the input with the default mount point', async () => {
    const snapshot = await example(10 * GIB);
    const result = previewVolumeCreate(REQUEST, snapshot);
    const input = { ...REQUEST, mountPoint: '/mnt/ohr/media' };
    expect(result).toEqual({ ok: true, value: input });
    expect(volumeSizeBytes(input, snapshot)).toBe(10 * GIB);
  });

  it('rounds a size down to whole extents and refuses less than one', async () => {
    const snapshot = await example(10 * GIB);
    const result = previewVolumeCreate(
      { ...REQUEST, size: { kind: 'bytes', bytes: GIB + MIB } },
      snapshot,
    );
    expect(result).toMatchObject({ ok: true, value: { size: { kind: 'bytes', bytes: GIB } } });
    expect(
      reasons(previewVolumeCreate({ ...REQUEST, size: { kind: 'bytes', bytes: MIB } }, snapshot)),
    ).toEqual([`A volume needs at least ${formatSize(4 * MIB)}.`]);
  });

  it('refuses a missing pool, a taken name or mount point, and too little space', async () => {
    const snapshot = await example(GIB);
    expect(reasons(previewVolumeCreate({ ...REQUEST, poolId: 'p9' }, snapshot))).toEqual([
      'There is no pool p9 on this machine (no volume group ohr-p9).',
    ]);
    expect(
      reasons(
        previewVolumeCreate(
          { ...REQUEST, name: 'data', size: { kind: 'bytes', bytes: 2 * GIB } },
          snapshot,
        ),
      ),
    ).toEqual([
      'Pool p1 already has a volume named data.',
      `Pool p1 has ${formatSize(GIB)} free, less than the ${formatSize(2 * GIB)} asked for.`,
      '/mnt/ohr/data already has something mounted on it.',
    ]);
    expect(reasons(previewVolumeCreate(REQUEST, await example(0)))).toEqual([
      'Pool p1 has no free space.',
    ]);
  });

  it('refuses a mount point that is not a normalized absolute path', async () => {
    const snapshot = await example(GIB);
    expect(reasons(previewVolumeCreate({ ...REQUEST, mountPoint: 'srv/media' }, snapshot))).toEqual(
      ['The mount point must be an absolute directory path, got "srv/media".'],
    );
  });
});

describe('recheckVolumeCreate', () => {
  it('accepts a previewed input while the pool still has room', async () => {
    const snapshot = await example(GIB);
    const result = previewVolumeCreate(REQUEST, snapshot);
    if (!result.ok) {
      throw new Error(result.reasons.join('\n'));
    }
    expect(recheckVolumeCreate(result.value, snapshot)).toEqual([]);
    expect(recheckVolumeCreate(result.value, await example(0))).toEqual([
      'Pool p1 has no free space.',
    ]);
  });

  it('refuses a size that is not whole extents, which no preview builds', async () => {
    const snapshot = await example(10 * GIB);
    expect(
      recheckVolumeCreate(
        { ...REQUEST, size: { kind: 'bytes', bytes: GIB + 1 }, mountPoint: '/mnt/ohr/media' },
        snapshot,
      ),
    ).toEqual(['The submitted volume does not match a fresh preview. Preview it again.']);
  });
});
