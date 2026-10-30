/**
 * Steps that give a running pool more space (decision 0011): add tier
 * partitions to drives in use, resize a physical volume after its array
 * grew, and add a new tier's array to the volume group. Each precondition
 * reads the live system, so a job can resume and re-run.
 */

import { volumeGroupName } from '@ohr/shared/naming';
import type { BlockDevice } from '@ohr/shared/parsers/lsblk';
import { lvmReportArgs, PV_FIELDS, parsePvs } from '@ohr/shared/parsers/lvm';
import type { PlannedPartition } from '@ohr/shared/planner';

import type { CommandRunner } from '../command-runner.ts';
import { extendVolumeGroup, resizePhysicalVolume, vgextendArgs } from '../executors/lvm.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import {
  addPartitions,
  partitionPath,
  partxAddArgs,
  sgdiskAddArgs,
} from '../executors/partition-drive.ts';
import { expectedLabel, findDrive } from './drive-steps.ts';
import { formatCommand, type Precondition, type StepDefinition } from './engine.ts';
import { alreadyDone, blocked, READY } from './pool-steps.ts';

/** True when the drive has each of the partitions, at the planned place and with its name. */
function hasPartitions(
  device: BlockDevice,
  poolId: string,
  partitions: readonly PlannedPartition[],
): boolean {
  return partitions.every((partition) =>
    device.children.some(
      (child) =>
        child.partNumber === partition.number &&
        child.startBytes === partition.startBytes &&
        child.sizeBytes === partition.sizeBytes &&
        child.partLabel === expectedLabel(poolId, partition),
    ),
  );
}

export function addPartitionsStep(
  poolId: string,
  drive: string,
  partitions: readonly PlannedPartition[],
): StepDefinition {
  const request = { devicePath: drive, poolId, partitions };
  const numbers = partitions.map((partition) => partition.number);
  const paths = numbers.map((number) => partitionPath(drive, number));
  return {
    name: `add partitions to ${drive}`,
    description: `Add partition ${numbers.join(', ')} to ${drive} without touching the others`,
    commands: [
      formatCommand('sgdisk', sgdiskAddArgs(request)),
      formatCommand('partx', partxAddArgs(drive, numbers)),
      'udevadm settle',
      ...paths.map((path) => formatCommand('wipefs', ['--all', '--quiet', path])),
    ],
    async precondition({ run }) {
      const found = await findDrive(run, drive);
      if (found === null) {
        return blocked(`${drive} is not on this machine`);
      }
      if (hasPartitions(found.device, poolId, partitions)) {
        return alreadyDone(`${drive} already has the new partitions`);
      }
      const taken = found.device.children.find((child) => numbers.includes(child.partNumber ?? 0));
      if (taken !== undefined) {
        return blocked(`${drive} already has a different partition ${taken.partNumber}`);
      }
      return READY;
    },
    async action({ run }) {
      await addPartitions(run, request);
    },
    async postcondition({ run }) {
      const found = await findDrive(run, drive);
      if (found === null || !hasPartitions(found.device, poolId, partitions)) {
        throw new Error(`${drive} does not show the new partitions`);
      }
    },
  };
}

export function resizePhysicalVolumeStep(poolId: string, tier: number): StepDefinition {
  const path = mdArrayPath(poolId, tier);
  return {
    name: `resize tier ${tier} physical volume`,
    description: `Let LVM use the space ${path} gained`,
    commands: [formatCommand('pvresize', [path])],
    // pvresize to the device's size changes nothing when it already has it.
    precondition: (): Promise<Precondition> => Promise.resolve(READY),
    async action({ run }) {
      await resizePhysicalVolume(run, path);
    },
    async postcondition({ run }) {
      const result = await run('pvs', [...lvmReportArgs(PV_FIELDS), path]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        throw new Error(`${path} is not a physical volume`);
      }
    },
  };
}

export function extendVolumeGroupStep(poolId: string, tier: number): StepDefinition {
  const path = mdArrayPath(poolId, tier);
  const group = volumeGroupName(poolId);
  const request = { poolId, physicalVolumes: [path] };
  const groupOf = async (run: CommandRunner): Promise<string | null | undefined> => {
    const result = await run('pvs', [...lvmReportArgs(PV_FIELDS), path]);
    if (result.kind !== 'exited' || result.exitCode !== 0) {
      return undefined;
    }
    return parsePvs(result.stdout)[0]?.volumeGroup;
  };
  return {
    name: `add tier ${tier} to volume group`,
    description: `Add ${path} to volume group ${group}`,
    commands: [formatCommand('vgextend', vgextendArgs(request))],
    async precondition({ run }) {
      const current = await groupOf(run);
      if (current === undefined) {
        return blocked(`${path} is not a physical volume`);
      }
      if (current === group) {
        return alreadyDone(`${path} is already in ${group}`);
      }
      if (current !== null) {
        return blocked(`${path} belongs to volume group ${current}`);
      }
      return READY;
    },
    async action({ run }) {
      await extendVolumeGroup(run, request);
    },
    async postcondition({ run }) {
      if ((await groupOf(run)) !== group) {
        throw new Error(`${path} is not in ${group} after vgextend`);
      }
    },
  };
}
