/**
 * The pool-expand job (decision 0011): add drives to a pool, use space its
 * drives already have, or both. The steps follow the planner's actions in
 * order. A tier that gains members is converted first if it is a
 * two-member RAID1, then gets its new members and is reshaped onto them,
 * and only then, with three or more members, gets the 512 KiB chunk.
 * Changing the chunk earlier deadlocks md under writes.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import type { ExpansionAction } from '@ohr/shared/expansion-plan';
import type { PoolExpandInput } from '@ohr/shared/pool-expand-input';

import { type BlockDeviceIo, blockDeviceIo } from '../executors/label-partition.ts';
import { mdKernelName } from '../executors/md-sync.ts';
import { partitionPath } from '../executors/partition-drive.ts';
import { readTextFile } from '../file-reader.ts';
import { type LabelDeps, labelStep, partitionStep } from './drive-steps.ts';
import type { JobDefinition, StepDefinition } from './engine.ts';
import {
  addPartitionsStep,
  extendVolumeGroupStep,
  resizePhysicalVolumeStep,
} from './expand-steps.ts';
import { arrayStep, mdadmConfStep, physicalVolumeStep } from './pool-steps.ts';
import {
  addMembersStep,
  chunkStep,
  convertStep,
  growStep,
  type MdDeps,
  waitStep,
} from './reshape-steps.ts';

interface Deps extends MdDeps, LabelDeps {
  readonly mdadmConfDir: string | undefined;
}

function partitionNumber(input: PoolExpandInput, tier: number): number {
  const planned = input.target.tiers.find((candidate) => candidate.tier === tier);
  if (planned === undefined) {
    throw new Error(`Tier ${tier} is not in the target layout`);
  }
  return planned.partitionNumber;
}

function newDriveSteps(
  input: PoolExpandInput,
  action: ExpansionAction,
  deps: Deps,
): StepDefinition[] {
  if (action.kind !== 'partition-drive') {
    return [];
  }
  const drive = input.newDrives.find((candidate) => candidate.path === action.drive);
  if (drive === undefined) {
    throw new Error(`${action.drive} is partitioned but is not one of the new drives`);
  }
  const { poolId, wipe } = input;
  return [
    partitionStep({ path: drive.path, poolId, partitions: action.partitions, wipe }),
    labelStep(
      {
        path: drive.path,
        poolId,
        poolUuid: input.poolUuid,
        driveUuid: drive.driveUuid,
        redundancy: input.redundancy,
        wipe,
      },
      deps,
    ),
  ];
}

function growTierSteps(
  input: PoolExpandInput,
  action: Extract<ExpansionAction, { kind: 'grow-tier' }>,
  deps: Deps,
): StepDefinition[] {
  const { poolId } = input;
  const number = partitionNumber(input, action.tier);
  const steps = [
    addMembersStep(
      poolId,
      { tier: action.tier, partitions: action.add.map((drive) => partitionPath(drive, number)) },
      deps,
    ),
    growStep(poolId, { tier: action.tier, members: action.members }, deps),
    waitStep(poolId, { tier: action.tier, what: 'reshape' }, deps),
  ];
  const converted = input.actions.some(
    (other) => other.kind === 'convert-to-raid5' && other.tier === action.tier,
  );
  if (converted) {
    steps.push(
      chunkStep(poolId, action.tier, deps),
      waitStep(poolId, { tier: action.tier, what: 'chunk change' }, deps),
    );
  }
  return steps;
}

function actionSteps(
  input: PoolExpandInput,
  action: ExpansionAction,
  deps: Deps,
): StepDefinition[] {
  const { poolId } = input;
  switch (action.kind) {
    case 'partition-drive':
      return newDriveSteps(input, action, deps);
    case 'add-partitions':
      return [addPartitionsStep(poolId, action.drive, action.partitions)];
    case 'convert-to-raid5':
      return [convertStep(poolId, action.tier, deps)];
    case 'grow-tier':
      return growTierSteps(input, action, deps);
    case 'resize-physical-volume':
      return [resizePhysicalVolumeStep(poolId, action.tier)];
    case 'create-tier':
      return [
        arrayStep(poolId, {
          tier: action.tier,
          level: action.level,
          partitionNumber: partitionNumber(input, action.tier),
          members: action.members,
        }),
        physicalVolumeStep(poolId, action.tier),
        extendVolumeGroupStep(poolId, action.tier),
      ];
    case 'replace-member':
      throw new Error('A pool-expand job does not replace members');
    default:
      throw new Error(`Unhandled expansion action: ${String(action satisfies never)}`);
  }
}

export interface PoolExpandDeps {
  /** Raw block device access for the new drives' label partitions. Tests inject a fake. */
  readonly labelIo?: BlockDeviceIo;
  /** Where the mdadm config file goes. The default is the system directory. */
  readonly mdadmConfDir?: string;
  /** Clock for the labels' writtenAt. */
  readonly now?: () => string;
  /** Reads /proc/mdstat and md sysfs files. */
  readonly files?: MdDeps['files'];
  readonly kernelName?: MdDeps['kernelName'];
  /** How often a wait step reads the array's state. The default is every 5 seconds. */
  readonly pollIntervalMs?: number;
  readonly delay?: MdDeps['delay'];
}

/** The steps that carry out the planned change. Pure: nothing is read or written here. */
export function buildPoolExpandJob(
  input: PoolExpandInput,
  deps: PoolExpandDeps = {},
): JobDefinition {
  const resolved: Deps = {
    labelIo: deps.labelIo ?? blockDeviceIo,
    mdadmConfDir: deps.mdadmConfDir,
    now: deps.now ?? (() => new Date().toISOString()),
    files: deps.files ?? readTextFile,
    kernelName: deps.kernelName ?? mdKernelName,
    pollIntervalMs: deps.pollIntervalMs,
    delay: deps.delay ?? ((ms) => sleep(ms)),
  };
  const steps = input.actions.flatMap((action) => actionSteps(input, action, resolved));
  steps.push(
    mdadmConfStep(
      input.poolId,
      input.target.tiers.map((tier) => tier.tier),
      resolved.mdadmConfDir,
    ),
  );
  return { kind: 'pool-expand', poolId: input.poolId, input, steps };
}
