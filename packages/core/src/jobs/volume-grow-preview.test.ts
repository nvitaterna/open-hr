import { describe, expect, it } from 'vitest';

import type { SystemSnapshot } from '@ohr/shared/system-snapshot';
import type { VolumeGrowRequest } from '@ohr/shared/volume-grow-request';

import {
  exampleShr1Answers,
  exampleShr1Labels,
  fakeFiles,
  fakeRunner,
  fixture,
  ok,
} from '../fake-system-test-helpers.ts';
import { readSystemState } from '../system-state.ts';
import { grownSizeBytes, previewVolumeGrow, recheckVolumeGrow } from './volume-grow-preview.ts';

const DATA_BYTES = 12_001_770_209_280;
const GIB = 1024 ** 3;
const ALREADY = /^Volume data is already .+\. Preview it again\.$/u;
const DATA_SOURCE = '"source": "/dev/mapper/ohr--p1-data[/@data]"';

/** The worked example with `freeBytes` free in its volume group. */
function machine(
  freeBytes: number,
  findmnt = fixture('example-shr1/findmnt.json'),
): Promise<SystemSnapshot> {
  const answers = exampleShr1Answers();
  const vgs = fixture('example-shr1/vgs.json').replace(
    '"vg_free": "0"',
    `"vg_free": "${freeBytes}"`,
  );
  answers.set('vgs', ok(vgs));
  answers.set('findmnt', ok(findmnt));
  return readSystemState({
    run: fakeRunner(answers).run,
    readFile: fakeFiles(new Map([['/proc/mdstat', fixture('example-shr1/mdstat.txt')]])),
    includeSmart: false,
    labelIo: exampleShr1Labels(),
  });
}

function request(size: VolumeGrowRequest['size'], name = 'data'): VolumeGrowRequest {
  return { poolId: 'p1', name, size };
}

describe('previewVolumeGrow', () => {
  it('grows into all free space, with the filesystem and mount point from the machine', async () => {
    const snapshot = await machine(10 * GIB);
    const result = previewVolumeGrow(request({ kind: 'all-free' }), snapshot);
    expect(result).toEqual({
      ok: true,
      value: {
        poolId: 'p1',
        name: 'data',
        filesystem: 'btrfs',
        mountPoint: '/mnt/ohr/data',
        size: { kind: 'all-free' },
      },
    });
    if (!result.ok) {
      throw new Error(result.reasons.join('; '));
    }
    expect(grownSizeBytes(result.value, snapshot)).toBe(DATA_BYTES + 10 * GIB);
  });

  it('turns an amount to add into the size afterwards, in whole extents', async () => {
    const snapshot = await machine(10 * GIB);
    const result = previewVolumeGrow(request({ kind: 'add-bytes', bytes: GIB + 1 }), snapshot);
    expect(result).toMatchObject({
      ok: true,
      value: { size: { kind: 'bytes', bytes: DATA_BYTES + GIB } },
    });
  });

  it('refuses no free space, too little, an unknown volume, and an unmounted one', async () => {
    expect(previewVolumeGrow(request({ kind: 'all-free' }), await machine(0))).toEqual({
      ok: false,
      reasons: ['Pool p1 has no free space.'],
    });
    const snapshot = await machine(GIB);
    expect(previewVolumeGrow(request({ kind: 'add-bytes', bytes: 2 * GIB }), snapshot).ok).toBe(
      false,
    );
    expect(previewVolumeGrow(request({ kind: 'all-free' }, 'other'), snapshot)).toEqual({
      ok: false,
      reasons: ['Pool p1 has no volume named other.'],
    });
    const unmounted = fixture('example-shr1/findmnt.json').replace(
      DATA_SOURCE,
      '"source": "/dev/sdz1"',
    );
    expect(previewVolumeGrow(request({ kind: 'all-free' }), await machine(GIB, unmounted))).toEqual(
      {
        ok: false,
        reasons: ['Volume data is not mounted. It grows online, so mount it first.'],
      },
    );
  });
});

describe('recheckVolumeGrow', () => {
  it('accepts a preview and refuses a size the volume already has', async () => {
    const snapshot = await machine(10 * GIB);
    const result = previewVolumeGrow(request({ kind: 'add-bytes', bytes: GIB }), snapshot);
    if (!result.ok) {
      throw new Error(result.reasons.join('; '));
    }
    expect(recheckVolumeGrow(result.value, snapshot)).toEqual([]);
    const already = { ...result.value, size: { kind: 'bytes' as const, bytes: DATA_BYTES } };
    expect(recheckVolumeGrow(already, snapshot)).toEqual([expect.stringMatching(ALREADY)]);
  });
});
