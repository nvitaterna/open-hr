/**
 * Steps for a drive that joins a pool (decisions 0004 and 0011): replace
 * its partition table with the planned partitions and write its label.
 * Pool-create and pool-expand both use them.
 */

import type { Redundancy } from '@ohr/shared/constants';
import { labelPartitionLabel, tierPartitionLabel } from '@ohr/shared/naming';
import { type BlockDevice, LSBLK_COLUMNS, parseLsblk } from '@ohr/shared/parsers/lsblk';
import type { PlannedPartition } from '@ohr/shared/planner';
import type { DriveRole } from '@ohr/shared/system-snapshot';

import type { CommandRunner } from '../command-runner.ts';
import { driveRole } from '../drive-roles.ts';
import { type BlockDeviceIo, readLabel, writeLabel } from '../executors/label-partition.ts';
import { partitionDrive, partitionPath, sgdiskArgs } from '../executors/partition-drive.ts';
import { formatCommand, type StepDefinition } from './engine.ts';
import { alreadyDone, blocked, READY } from './pool-steps.ts';

const LABEL_PARTITION_NUMBER = 1;
/** lsblk types for a whole device. Loop devices are what the integration tests use. */
const WHOLE_DEVICE_TYPES: ReadonlySet<string> = new Set(['disk', 'loop']);

export function expectedLabel(poolId: string, partition: PlannedPartition): string {
  if (partition.tier === null) {
    return labelPartitionLabel(poolId);
  }
  return tierPartitionLabel(poolId, partition.tier);
}

/** True when the drive carries exactly the planned partitions with their names. */
export function matchesPlan(
  device: BlockDevice,
  poolId: string,
  planned: { readonly partitions: readonly PlannedPartition[] },
): boolean {
  const actual = [...device.children].sort((a, b) => (a.partNumber ?? 0) - (b.partNumber ?? 0));
  if (actual.length !== planned.partitions.length) {
    return false;
  }
  return planned.partitions.every((partition, index) => {
    const child = actual[index];
    return (
      child !== undefined &&
      child.partNumber === partition.number &&
      child.sizeBytes === partition.sizeBytes &&
      child.partLabel === expectedLabel(poolId, partition)
    );
  });
}

export interface FoundDrive {
  readonly device: BlockDevice;
  readonly role: DriveRole;
}

/** The drive as lsblk sees it right now, or null if it is not there. Asks for that device only. */
export async function findDrive(run: CommandRunner, path: string): Promise<FoundDrive | null> {
  const result = await run('lsblk', [
    '--json',
    '--bytes',
    '--output',
    LSBLK_COLUMNS.join(','),
    path,
  ]);
  if (result.kind !== 'exited' || result.exitCode !== 0) {
    return null;
  }
  const device = parseLsblk(result.stdout).find((candidate) => candidate.path === path);
  if (device === undefined || !WHOLE_DEVICE_TYPES.has(device.type)) {
    return null;
  }
  return { device, role: driveRole(device) };
}

export function partitionStep(drive: NewDrive): StepDefinition {
  const planned = { partitions: drive.partitions };
  const request = { devicePath: drive.path, poolId: drive.poolId, partitions: drive.partitions };
  const paths = drive.partitions.map((partition) => partitionPath(drive.path, partition.number));
  return {
    name: `partition ${drive.path}`,
    description: `Partition ${drive.path} into ${planned.partitions.length} partitions`,
    commands: [
      formatCommand('sgdisk', sgdiskArgs(request)),
      'udevadm settle',
      ...paths.map((path) => formatCommand('wipefs', ['--all', '--quiet', path])),
    ],
    async precondition({ run }) {
      const found = await findDrive(run, drive.path);
      if (found === null) {
        return blocked(`${drive.path} is not a physical drive on this machine`);
      }
      if (found.role === 'system') {
        return blocked(`${drive.path} holds the operating system`);
      }
      if (matchesPlan(found.device, drive.poolId, planned)) {
        return alreadyDone(`${drive.path} already has the planned partitions`);
      }
      if (found.role !== 'empty' && !drive.wipe) {
        return blocked(`${drive.path} is not empty and wiping was not chosen`);
      }
      return READY;
    },
    async action({ run }) {
      await partitionDrive(run, request);
    },
    async postcondition({ run }) {
      const found = await findDrive(run, drive.path);
      if (found === null || !matchesPlan(found.device, drive.poolId, planned)) {
        throw new Error(`${drive.path} does not show the planned partitions`);
      }
    },
  };
}

export function labelStep(drive: LabelledDrive, deps: LabelDeps): StepDefinition {
  const partition = partitionPath(drive.path, LABEL_PARTITION_NUMBER);
  const fields = {
    poolId: drive.poolId,
    poolUuid: drive.poolUuid,
    driveUuid: drive.driveUuid,
    redundancy: drive.redundancy,
  };
  return {
    name: `label ${drive.path}`,
    description: `Write the Open HR label on ${partition}`,
    commands: [
      `dd if=/dev/zero of=${partition} bs=1M count=16`,
      `dd if=label.json of=${partition} conv=fsync`,
    ],
    async precondition() {
      const label = await readLabel(deps.labelIo, partition);
      if (label.kind === 'unsupported') {
        return blocked(
          `${partition} holds a label from a newer Open HR (layout ${label.layoutVersion})`,
        );
      }
      if (label.kind !== 'ok') {
        return READY;
      }
      if (
        label.descriptor.poolUuid === drive.poolUuid &&
        label.descriptor.driveUuid === drive.driveUuid
      ) {
        return alreadyDone(`${partition} already holds this drive's label`);
      }
      if (!drive.wipe) {
        return blocked(`${partition} holds a label of pool ${label.descriptor.poolId}`);
      }
      return READY;
    },
    async action() {
      await writeLabel(deps.labelIo, partition, { ...fields, writtenAt: deps.now() });
    },
    async postcondition() {
      const label = await readLabel(deps.labelIo, partition);
      if (label.kind !== 'ok' || label.descriptor.driveUuid !== drive.driveUuid) {
        throw new Error(`${partition} does not read back the label that was written`);
      }
    },
  };
}

/** A drive that joins a pool: its whole partition table is replaced with `partitions`. */
export interface NewDrive {
  readonly path: string;
  readonly poolId: string;
  readonly partitions: readonly PlannedPartition[];
  /** The user chose to erase what the drive holds. */
  readonly wipe: boolean;
}

/** What goes into a new drive's label partition. */
export interface LabelledDrive {
  readonly path: string;
  readonly poolId: string;
  readonly poolUuid: string;
  readonly driveUuid: string;
  readonly redundancy: Redundancy;
  readonly wipe: boolean;
}

export interface LabelDeps {
  readonly labelIo: BlockDeviceIo;
  readonly now: () => string;
}
