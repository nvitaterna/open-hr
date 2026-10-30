/**
 * The pool and drive views from @ohr/shared/pool-view, checked against
 * snapshots of the worked example. They live here because building a
 * snapshot from the fixtures needs core's reader.
 */

import { describe, expect, it } from 'vitest';

import { encodeLabelDescriptor } from '@ohr/shared/label-descriptor';
import { deriveDrives, derivePools, type PoolView } from '@ohr/shared/pool-view';

import type { BlockDeviceIo } from './executors/label-partition.ts';
import {
  EXAMPLE_POOL_UUID,
  exampleShr1Answers,
  exampleShr1Labels,
  fakeFiles,
  fakeLabelIo,
  fakeRunner,
  fixture,
} from './fake-system-test-helpers.ts';
import { readSystemState } from './system-state.ts';

const MD127_HEALTHY =
  /md127 : active raid5 sdc2\[2\] sdb2\[1\] sda2\[0\]\n(?<blocks>.*)\[3\/3\] \[UUU\]/u;
const MD127_BLOCK = /md127 : [^\n]*\n[^\n]*\n[^\n]*\n\n/u;
const RECOVERY_LINE =
  '      [=>...................]  recovery =  8.5% (332211200/3906886144) finish=301.2min speed=197800K/sec';

function labelOption(labelIo: BlockDeviceIo | null): { labelIo?: BlockDeviceIo } {
  if (labelIo === null) {
    return {};
  }
  return { labelIo };
}

/** The worked example with its /proc/mdstat changed by `edit`. */
async function pools(
  edit: (mdstat: string) => string = (mdstat) => mdstat,
  /** Null reads no labels, as without root. */
  labelIo: BlockDeviceIo | null = exampleShr1Labels(),
): Promise<PoolView[]> {
  const snapshot = await readSystemState({
    run: fakeRunner(exampleShr1Answers()).run,
    readFile: fakeFiles(new Map([['/proc/mdstat', edit(fixture('example-shr1/mdstat.txt'))]])),
    includeSmart: false,
    ...labelOption(labelIo),
  });
  return derivePools(snapshot);
}

async function onlyPool(...args: Parameters<typeof pools>): Promise<PoolView> {
  const [pool, ...rest] = await pools(...args);
  if (pool === undefined || rest.length > 0) {
    throw new Error('expected exactly one pool');
  }
  return pool;
}

describe('derivePools: the worked example', () => {
  it('finds the pool with its labels, tiers, members, and volume', async () => {
    const pool = await onlyPool();
    expect(pool).toMatchObject({
      id: 'p1',
      uuid: EXAMPLE_POOL_UUID,
      redundancy: 'shr1',
      health: 'healthy',
      sizeBytes: 12_001_770_209_280,
      freeBytes: 0,
      warnings: [],
    });
    expect(pool.drives.map((drive) => [drive.path, drive.label, drive.driveUuid])).toEqual([
      ['/dev/sda', 'ok', '00000000-0000-4000-8000-000000000001'],
      ['/dev/sdb', 'ok', '00000000-0000-4000-8000-000000000002'],
      ['/dev/sdc', 'ok', '00000000-0000-4000-8000-000000000003'],
    ]);
    expect(pool.tiers.map((tier) => [tier.tier, tier.kernelName, tier.level, tier.health])).toEqual(
      [
        [1, 'md127', 'raid5', 'healthy'],
        [2, 'md126', 'raid1', 'healthy'],
      ],
    );
    expect(pool.tiers[0]?.arrayPath).toBe('/dev/md/ohr_p1_t1');
    expect(pool.tiers[1]?.members).toEqual([
      { drive: '/dev/sdb', partition: '/dev/sdb3', state: 'active' },
      { drive: '/dev/sdc', partition: '/dev/sdc3', state: 'active' },
    ]);
    expect(pool.volumes).toEqual([
      {
        name: 'data',
        path: '/dev/ohr-p1/data',
        sizeBytes: 12_001_770_209_280,
        filesystem: 'btrfs',
        mountPoint: '/mnt/ohr/data',
        usedBytes: expect.any(Number),
        availableBytes: expect.any(Number),
      },
    ]);
  });

  it('works without labels, which need root, and says they were not read', async () => {
    const pool = await onlyPool(undefined, null);
    expect(pool.uuid).toBeNull();
    expect(pool.redundancy).toBeNull();
    expect(pool.drives.every((drive) => drive.label === 'not-read')).toBe(true);
    expect(pool.health).toBe('healthy');
    expect(pool.warnings).toEqual([]);
  });

  it('warns about a label it cannot read', async () => {
    const io = fakeLabelIo(
      new Map([
        ['/dev/sda1', new TextEncoder().encode('{"format":"something-else"}\n')],
        [
          '/dev/sdb1',
          encodeLabelDescriptor({
            poolId: 'p1',
            poolUuid: EXAMPLE_POOL_UUID,
            driveUuid: '00000000-0000-4000-8000-000000000002',
            redundancy: 'shr1',
            writtenAt: '2026-10-29T12:00:00.000Z',
          }),
        ],
      ]),
    );
    const pool = await onlyPool(undefined, io);
    expect(pool.drives.map((drive) => drive.label)).toEqual(['invalid', 'ok', 'unreadable']);
    expect(pool.uuid).toBe(EXAMPLE_POOL_UUID);
    expect(pool.warnings).toEqual([
      'The label on /dev/sda1 could not be read: not an Open HR label.',
      'The label on /dev/sdc1 could not be read: ENOENT: no such device /dev/sdc1.',
    ]);
  });

  it('warns about an empty label partition', async () => {
    const io = fakeLabelIo(
      new Map(['/dev/sda1', '/dev/sdb1', '/dev/sdc1'].map((path) => [path, new Uint8Array(64)])),
    );
    const pool = await onlyPool(undefined, io);
    expect(pool.drives.every((drive) => drive.label === 'empty')).toBe(true);
    expect(pool.warnings).toEqual([
      'The label partition /dev/sda1 is empty.',
      'The label partition /dev/sdb1 is empty.',
      'The label partition /dev/sdc1 is empty.',
    ]);
  });
});

describe('derivePools: health', () => {
  it('shows a failed member and a degraded pool', async () => {
    const pool = await onlyPool((mdstat) =>
      mdstat.replace(
        MD127_HEALTHY,
        'md127 : active raid5 sdc2[2] sdb2[1] sda2[0](F)\n$<blocks>[3/2] [_UU]',
      ),
    );
    expect(pool.health).toBe('degraded');
    expect(pool.tiers[0]?.health).toBe('degraded');
    expect(pool.tiers[0]?.members.map((member) => member.state)).toEqual([
      'faulty',
      'active',
      'active',
    ]);
  });

  it('shows a member being rebuilt with its progress', async () => {
    const pool = await onlyPool((mdstat) =>
      mdstat.replace(
        MD127_HEALTHY,
        (match) => `${match.replace('[3/3] [UUU]', '[3/2] [_UU]')}\n${RECOVERY_LINE}`,
      ),
    );
    expect(pool.health).toBe('rebuilding');
    expect(pool.tiers[0]).toMatchObject({
      health: 'rebuilding',
      sync: { action: 'recovery', percent: 8.5, finishMinutes: 301.2 },
    });
    expect(pool.tiers[0]?.members[0]?.state).toBe('rebuilding');
  });

  it('shows a drive that is in none of the running arrays as no longer in the pool', async () => {
    const pool = await onlyPool((mdstat) =>
      mdstat.replace(MD127_HEALTHY, 'md127 : active raid5 sdc2[2] sdb2[1]\n$<blocks>[3/2] [_UU]'),
    );
    expect(pool.drives.map((drive) => [drive.path, drive.membership])).toEqual([
      ['/dev/sda', 'removed'],
      ['/dev/sdb', 'member'],
      ['/dev/sdc', 'member'],
    ]);
    expect(pool.tiers[0]?.members.map((member) => member.drive)).toEqual(['/dev/sdb', '/dev/sdc']);
    expect(pool.tiers[0]?.health).toBe('degraded');
  });

  it('marks the pool unavailable when a tier array is not running', async () => {
    const pool = await onlyPool((mdstat) => mdstat.replace(MD127_BLOCK, ''));
    expect(pool.health).toBe('unavailable');
    expect(pool.tiers[0]).toMatchObject({ health: 'missing', kernelName: null });
    expect(pool.tiers[0]?.members.every((member) => member.state === 'missing')).toBe(true);
    expect(pool.warnings).toContain('The array for tier 1 is not running.');
  });
});

describe('deriveDrives', () => {
  it('lists every drive with its role and pool', async () => {
    const snapshot = await readSystemState({
      run: fakeRunner(exampleShr1Answers()).run,
      readFile: fakeFiles(new Map([['/proc/mdstat', fixture('example-shr1/mdstat.txt')]])),
      includeSmart: true,
    });
    const drives = deriveDrives(snapshot);
    expect(drives.map((drive) => [drive.path, drive.role, drive.poolId])).toEqual([
      ['/dev/nvme0n1', 'system', null],
      ['/dev/sda', 'ohr', 'p1'],
      ['/dev/sdb', 'ohr', 'p1'],
      ['/dev/sdc', 'ohr', 'p1'],
    ]);
    expect(drives[1]?.temperatureCelsius).toEqual(expect.any(Number));
    expect(drives[2]?.smartPassed).toBe(false);
  });
});
