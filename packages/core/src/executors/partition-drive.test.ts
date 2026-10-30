import { describe, expect, it } from 'vitest';

import { type PlannedPartition, planPool } from '@ohr/shared/planner';

import { CommandError } from '../command-runner.ts';
import { fakeRunner, ok } from '../fake-system-test-helpers.ts';
import {
  addPartitions,
  partitionDrive,
  partitionPath,
  partxAddArgs,
  sgdiskAddArgs,
  sgdiskArgs,
} from './partition-drive.ts';

const GIB = 1024 ** 3;
const START_ERROR = /Partition 2 start/u;
const NOT_A_TIER = /Only tier partitions are added to a drive in use, not label/u;
const NOTHING_TO_ADD = /at least one partition to add/u;

/** The tier partitions of the planned 8 GiB drive, without its label partition. */
function tierPartitions(): readonly PlannedPartition[] {
  return plannedPartitions().filter((partition) => partition.role === 'tier');
}

/** The partitions planned for an 8 GiB drive in a 4, 8, 8 GiB pool. */
function plannedPartitions(): readonly PlannedPartition[] {
  const plan = planPool(
    [
      { id: 'a', sizeBytes: 4 * GIB },
      { id: 'b', sizeBytes: 8 * GIB },
      { id: 'c', sizeBytes: 8 * GIB },
    ],
    'shr1',
  );
  if (!plan.ok) {
    throw new Error('plan failed');
  }
  const [, drive] = plan.layout.drives;
  if (drive === undefined) {
    throw new Error('no drive');
  }
  return drive.partitions;
}

describe('partitionPath', () => {
  it.each([
    ['/dev/sda', 2, '/dev/sda2'],
    ['/dev/vdb', 1, '/dev/vdb1'],
    ['/dev/nvme0n1', 3, '/dev/nvme0n1p3'],
    ['/dev/loop7', 2, '/dev/loop7p2'],
    ['/dev/mmcblk0', 1, '/dev/mmcblk0p1'],
  ])('%s partition %i is %s', (device, number, path) => {
    expect(partitionPath(device, number)).toBe(path);
  });
});

describe('sgdiskArgs', () => {
  it('creates every planned partition with its type and name', () => {
    expect(
      sgdiskArgs({ devicePath: '/dev/sdb', poolId: 'p1', partitions: plannedPartitions() }),
    ).toEqual([
      '--clear',
      ...['--new', '1:1M:+16M', '--typecode', '1:8300', '--change-name', '1:ohr-p1-label'],
      ...['--new', '2:17M:+4015M', '--typecode', '2:FD00', '--change-name', '2:ohr-p1-t1'],
      ...['--new', '3:4032M:+4096M', '--typecode', '3:FD00', '--change-name', '3:ohr-p1-t2'],
      '/dev/sdb',
    ]);
  });

  it('refuses a partition that is not MiB aligned', () => {
    const partitions = [
      { number: 2, role: 'tier', tier: 1, startBytes: 17 * 1024 * 1024 + 512, sizeBytes: GIB },
    ] as const;
    expect(() => sgdiskArgs({ devicePath: '/dev/sdb', poolId: 'p1', partitions })).toThrow(
      START_ERROR,
    );
  });
});

describe('partitionDrive', () => {
  it('partitions, waits for udev, and wipes each new partition', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['sgdisk', ok('')],
        ['udevadm', ok('')],
        ['wipefs', ok('')],
      ]),
    );
    const paths = await partitionDrive(run, {
      devicePath: '/dev/nvme0n1',
      poolId: 'p1',
      partitions: plannedPartitions(),
    });
    expect(paths).toEqual(['/dev/nvme0n1p1', '/dev/nvme0n1p2', '/dev/nvme0n1p3']);
    expect(calls.map((call) => [call.command, call.args.at(-1)])).toEqual([
      ['sgdisk', '/dev/nvme0n1'],
      ['udevadm', 'settle'],
      ['wipefs', '/dev/nvme0n1p1'],
      ['wipefs', '/dev/nvme0n1p2'],
      ['wipefs', '/dev/nvme0n1p3'],
    ]);
  });

  it('stops at the first failing command', async () => {
    const { run, calls } = fakeRunner(
      new Map([['sgdisk', { kind: 'exited', exitCode: 4, stdout: '', stderr: 'disk busy' }]]),
    );
    await expect(
      partitionDrive(run, {
        devicePath: '/dev/sdb',
        poolId: 'p1',
        partitions: plannedPartitions(),
      }),
    ).rejects.toThrow(CommandError);
    expect(calls).toHaveLength(1);
  });
});

describe('sgdiskAddArgs', () => {
  it('adds the partitions without clearing the table', () => {
    const args = sgdiskAddArgs({
      devicePath: '/dev/sdb',
      poolId: 'p1',
      partitions: tierPartitions(),
    });
    expect(args).not.toContain('--clear');
    expect(args.slice(0, 6)).toEqual([
      ...['--new', '2:17M:+4015M'],
      ...['--typecode', '2:FD00'],
      ...['--change-name', '2:ohr-p1-t1'],
    ]);
    expect(args.at(-1)).toBe('/dev/sdb');
  });

  it('refuses a label partition, which only a new drive gets', () => {
    expect(() =>
      sgdiskAddArgs({ devicePath: '/dev/sdb', poolId: 'p1', partitions: plannedPartitions() }),
    ).toThrow(NOT_A_TIER);
  });

  it('refuses to add nothing', () => {
    expect(() => sgdiskAddArgs({ devicePath: '/dev/sdb', poolId: 'p1', partitions: [] })).toThrow(
      NOTHING_TO_ADD,
    );
  });
});

describe('partxAddArgs', () => {
  it('tells the kernel about one partition', () => {
    expect(partxAddArgs('/dev/sdb', [3])).toEqual(['--add', '--nr', '3:3', '/dev/sdb']);
  });

  it('covers every new partition in one range', () => {
    expect(partxAddArgs('/dev/sdb', [4, 3])).toEqual(['--add', '--nr', '3:4', '/dev/sdb']);
  });

  it('refuses to add nothing', () => {
    expect(() => partxAddArgs('/dev/sdb', [])).toThrow(NOTHING_TO_ADD);
  });
});

describe('addPartitions', () => {
  it('adds the partitions, tells the kernel about them, and wipes them', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        ['sgdisk', ok('')],
        ['partx', ok('')],
        ['udevadm', ok('')],
        ['wipefs', ok('')],
      ]),
    );
    const partitions = tierPartitions();
    const paths = await addPartitions(run, {
      devicePath: '/dev/nvme0n1',
      poolId: 'p1',
      partitions,
    });
    const expected = partitions.map((partition) => `/dev/nvme0n1p${partition.number}`);
    expect(paths).toEqual(expected);
    expect(calls.map((call) => call.command)).toEqual([
      'sgdisk',
      'partx',
      'udevadm',
      ...partitions.map(() => 'wipefs'),
    ]);
    expect(calls[1]?.args).toEqual(['--add', '--nr', '2:3', '/dev/nvme0n1']);
  });

  it('stops before partx when sgdisk refuses', async () => {
    const { run, calls } = fakeRunner(
      new Map([
        [
          'sgdisk',
          { kind: 'exited', exitCode: 4, stdout: '', stderr: 'Could not create partition' },
        ],
      ]),
    );
    await expect(
      addPartitions(run, { devicePath: '/dev/sdb', poolId: 'p1', partitions: tierPartitions() }),
    ).rejects.toThrow(CommandError);
    expect(calls).toHaveLength(1);
  });
});
