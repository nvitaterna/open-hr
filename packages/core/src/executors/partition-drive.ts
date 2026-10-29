/**
 * Writes a planned partition table to one drive with sgdisk (decision 0004).
 * Destructive: it replaces the drive's partition table. The caller checks the
 * drive is safe to use first; this only carries out the plan.
 */

import { labelPartitionLabel, tierPartitionLabel } from '@ohr/shared/naming';
import type { PlannedPartition } from '@ohr/shared/planner';

import { type CommandRunner, runChecked } from '../command-runner.ts';

const BYTES_PER_MIB = 1_048_576;
const LINUX_RAID_TYPE = 'FD00';
const LINUX_FILESYSTEM_TYPE = '8300';
const ENDS_IN_DIGIT = /\d$/u;
/** sgdisk can be slow on large or sleeping drives. */
const SGDISK_TIMEOUT_MS = 120_000;

function mebibytes(bytes: number, what: string): number {
  if (!Number.isSafeInteger(bytes) || bytes % BYTES_PER_MIB !== 0) {
    throw new RangeError(`${what} must be a whole number of MiB, got ${bytes} bytes`);
  }
  return bytes / BYTES_PER_MIB;
}

function typeCode(partition: PlannedPartition): string {
  if (partition.role === 'label') {
    return LINUX_FILESYSTEM_TYPE;
  }
  return LINUX_RAID_TYPE;
}

function partitionName(poolId: string, partition: PlannedPartition): string {
  if (partition.role === 'label' || partition.tier === null) {
    return labelPartitionLabel(poolId);
  }
  return tierPartitionLabel(poolId, partition.tier);
}

export interface PartitionDriveRequest {
  /** Kernel device path, such as /dev/sda or /dev/nvme0n1. Not a /dev/disk/by-* link. */
  readonly devicePath: string;
  readonly poolId: string;
  readonly partitions: readonly PlannedPartition[];
}

/** Path of partition `number` on a drive, using the kernel's naming rule. */
export function partitionPath(devicePath: string, number: number): string {
  if (ENDS_IN_DIGIT.test(devicePath)) {
    return `${devicePath}p${number}`;
  }
  return `${devicePath}${number}`;
}

/** sgdisk arguments that replace the drive's table with exactly the planned partitions. */
export function sgdiskArgs(request: PartitionDriveRequest): string[] {
  const args = ['--clear'];
  for (const partition of request.partitions) {
    const { number } = partition;
    const start = mebibytes(partition.startBytes, `Partition ${number} start`);
    const size = mebibytes(partition.sizeBytes, `Partition ${number} size`);
    args.push(
      '--new',
      `${number}:${start}M:+${size}M`,
      '--typecode',
      `${number}:${typeCode(partition)}`,
      '--change-name',
      `${number}:${partitionName(request.poolId, partition)}`,
    );
  }
  args.push(request.devicePath);
  return args;
}

/**
 * Partitions the drive, waits for udev to create the partition devices, and
 * wipes any old signatures inside them, such as an md superblock from an
 * earlier pool. Returns the new partition paths in plan order.
 */
export async function partitionDrive(
  run: CommandRunner,
  request: PartitionDriveRequest,
): Promise<string[]> {
  const args = sgdiskArgs(request);
  await runChecked(run, 'sgdisk', args, { timeoutMs: SGDISK_TIMEOUT_MS });
  await runChecked(run, 'udevadm', ['settle']);
  const paths = request.partitions.map((partition) =>
    partitionPath(request.devicePath, partition.number),
  );
  await Promise.all(paths.map((path) => runChecked(run, 'wipefs', ['--all', '--quiet', path])));
  return paths;
}
