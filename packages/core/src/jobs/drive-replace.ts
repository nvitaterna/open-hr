/**
 * The drive-replace job (decision 0011): put a new drive in place of one
 * member drive, which may be healthy, failed, or gone. The new drive is
 * partitioned and labelled, then each tier the old drive was in moves onto
 * it: copied live with mdadm --replace where the old member still works,
 * so the tier keeps its redundancy, or rebuilt where it failed or is gone.
 * The old drive is never erased; it shows as no longer in the pool.
 */

import type { DriveReplaceInput } from '@ohr/shared/drive-replace-input';
import type { ExpansionAction } from '@ohr/shared/expansion-plan';

import { partitionPath } from '../executors/partition-drive.ts';
import { newDriveSteps, targetPartitionNumber } from './drive-steps.ts';
import type { JobDefinition, StepDefinition } from './engine.ts';
import { type PoolChangeDeps, type PoolExpandDeps, resolvePoolChangeDeps } from './pool-expand.ts';
import { mdadmConfStep } from './pool-steps.ts';
import { rebuildStep, removeStep, replaceStep } from './replace-steps.ts';
import { addMembersStep } from './reshape-steps.ts';
import { waitStep } from './wait-step.ts';

type ReplaceMember = Extract<ExpansionAction, { kind: 'replace-member' }>;

function liveSteps(
  input: DriveReplaceInput,
  action: ReplaceMember,
  deps: PoolChangeDeps,
): StepDefinition[] {
  if (action.oldDrive === null) {
    throw new Error(`Tier ${action.tier} cannot be copied live from a drive that is gone`);
  }
  const { poolId } = input;
  const number = targetPartitionNumber(input, action.tier);
  const oldPartition = partitionPath(action.oldDrive, number);
  const newPartition = partitionPath(action.newDrive, number);
  return [
    addMembersStep(poolId, { tier: action.tier, partitions: [newPartition] }, deps),
    replaceStep(poolId, { tier: action.tier, oldPartition, newPartition }, deps),
    waitStep(poolId, { tier: action.tier, what: 'copy', untilInSync: true }, deps),
    removeStep(poolId, { tier: action.tier, member: oldPartition }, deps),
  ];
}

function rebuildSteps(
  input: DriveReplaceInput,
  action: ReplaceMember,
  deps: PoolChangeDeps,
): StepDefinition[] {
  const { poolId } = input;
  const number = targetPartitionNumber(input, action.tier);
  let member = 'failed';
  if (action.oldDrive !== null) {
    member = partitionPath(action.oldDrive, number);
  }
  return [
    removeStep(poolId, { tier: action.tier, member }, deps),
    rebuildStep(
      poolId,
      { tier: action.tier, partition: partitionPath(action.newDrive, number) },
      deps,
    ),
    waitStep(poolId, { tier: action.tier, what: 'rebuild', untilInSync: true }, deps),
  ];
}

function actionSteps(
  input: DriveReplaceInput,
  action: ExpansionAction,
  deps: PoolChangeDeps,
): StepDefinition[] {
  if (action.kind === 'partition-drive') {
    return newDriveSteps(input, action, deps);
  }
  if (action.kind !== 'replace-member') {
    throw new Error(`A drive-replace job does not ${action.kind}`);
  }
  if (action.mode === 'live') {
    return liveSteps(input, action, deps);
  }
  return rebuildSteps(input, action, deps);
}

/** The steps that carry out the planned replacement. Pure: nothing is read or written here. */
export function buildDriveReplaceJob(
  input: DriveReplaceInput,
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
  return { kind: 'drive-replace', poolId: input.poolId, input, steps };
}
