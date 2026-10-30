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
import { type LabelDeps, newDriveSteps, targetPartitionNumber } from './drive-steps.ts';
import type { JobDefinition, StepDefinition } from './engine.ts';
import {
  addPartitionsStep,
  extendVolumeGroupStep,
  resizePhysicalVolumeStep,
} from './expand-steps.ts';
import { arrayStep, mdadmConfStep, physicalVolumeStep } from './pool-steps.ts';
import { addMembersStep, chunkStep, convertStep, growStep, type MdDeps } from './reshape-steps.ts';
import { volumeGrowSteps } from './volume-grow.ts';
import { waitStep } from './wait-step.ts';

function growTierSteps(
  input: PoolExpandInput,
  action: Extract<ExpansionAction, { kind: 'grow-tier' }>,
  deps: PoolChangeDeps,
): StepDefinition[] {
  const { poolId } = input;
  const number = targetPartitionNumber(input, action.tier);
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
  deps: PoolChangeDeps,
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
          partitionNumber: targetPartitionNumber(input, action.tier),
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
  /** Resolves device symlinks when checking a grown volume's mount. Tests inject identity. */
  readonly resolvePath?: (path: string) => Promise<string>;
}

/** The steps that carry out the planned change. Pure: nothing is read or written here. */
export function buildPoolExpandJob(
  input: PoolExpandInput,
  deps: PoolExpandDeps = {},
): JobDefinition {
  const resolved = resolvePoolChangeDeps(deps);
  const steps = input.actions.flatMap((action) => actionSteps(input, action, resolved));
  steps.push(
    mdadmConfStep(
      input.poolId,
      input.target.tiers.map((tier) => tier.tier),
      resolved.mdadmConfDir,
    ),
  );
  if (input.growVolume !== null && input.growVolume !== undefined) {
    steps.push(...volumeGrowSteps(input.poolId, input.growVolume, deps));
  }
  return { kind: 'pool-expand', poolId: input.poolId, input, steps };
}

/** What the steps of a job that changes a pool need, with real defaults for anything not given. */
export function resolvePoolChangeDeps(deps: PoolExpandDeps): PoolChangeDeps {
  return {
    labelIo: deps.labelIo ?? blockDeviceIo,
    mdadmConfDir: deps.mdadmConfDir,
    now: deps.now ?? (() => new Date().toISOString()),
    files: deps.files ?? readTextFile,
    kernelName: deps.kernelName ?? mdKernelName,
    pollIntervalMs: deps.pollIntervalMs,
    delay: deps.delay ?? ((ms) => sleep(ms)),
  };
}

export interface PoolChangeDeps extends MdDeps, LabelDeps {
  readonly mdadmConfDir: string | undefined;
}
