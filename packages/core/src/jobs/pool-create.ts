/**
 * The pool-create job (plan section 4.2): partition every drive, write the
 * labels, create one array per tier, put the arrays under one volume group,
 * and record the arrays for mdadm. Each step's precondition reads the live
 * system, so the job can be resumed and re-run safely. Volumes are a
 * separate job.
 */

import { volumeGroupName } from '@ohr/shared/naming';
import { lvmReportArgs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import type { PlannedDrive, PlannedTier } from '@ohr/shared/planner';
import type { PoolCreateInput } from '@ohr/shared/pool-create-input';

import { type BlockDeviceIo, blockDeviceIo } from '../executors/label-partition.ts';
import { createVolumeGroup, vgcreateArgs } from '../executors/lvm.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import { labelStep, partitionStep } from './drive-steps.ts';
import { formatCommand, type JobDefinition, type StepDefinition } from './engine.ts';
import {
  alreadyDone,
  arrayStep,
  blocked,
  mdadmConfStep,
  physicalVolumeStep,
  READY,
  type TierSpec,
} from './pool-steps.ts';

interface Deps {
  readonly labelIo: BlockDeviceIo;
  readonly mdadmConfDir: string | undefined;
  readonly now: () => string;
}

function plannedDrive(input: PoolCreateInput, path: string): PlannedDrive {
  const drive = input.layout.drives.find((candidate) => candidate.id === path);
  if (drive === undefined) {
    throw new Error(`${path} is not in the planned layout`);
  }
  return drive;
}

function tierSpec(tier: PlannedTier): TierSpec {
  return {
    tier: tier.tier,
    level: tier.level,
    partitionNumber: tier.partitionNumber,
    members: tier.members,
  };
}

function volumeGroupStep(input: PoolCreateInput): StepDefinition {
  const group = volumeGroupName(input.poolId);
  const arrays = input.layout.tiers.map((tier) => mdArrayPath(input.poolId, tier.tier));
  const request = { poolId: input.poolId, physicalVolumes: arrays };
  return {
    name: 'create volume group',
    description: `Create volume group ${group} from ${arrays.length} arrays`,
    commands: [formatCommand('vgcreate', vgcreateArgs(request))],
    async precondition({ run }) {
      const result = await run('vgs', [...lvmReportArgs(VG_FIELDS), group]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        return READY;
      }
      const [found] = parseVgs(result.stdout);
      if (found !== undefined && found.physicalVolumeCount === arrays.length) {
        return alreadyDone(`${group} already exists with ${arrays.length} physical volumes`);
      }
      return blocked(
        `${group} already exists with ${found?.physicalVolumeCount ?? 0} physical volumes`,
      );
    },
    async action({ run }) {
      await createVolumeGroup(run, request);
    },
    async postcondition({ run }) {
      const result = await run('vgs', [...lvmReportArgs(VG_FIELDS), group]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        throw new Error(`${group} is not there after vgcreate`);
      }
      const [found] = parseVgs(result.stdout);
      if (found?.physicalVolumeCount !== arrays.length) {
        throw new Error(
          `${group} has ${found?.physicalVolumeCount ?? 0} physical volumes, not ${arrays.length}`,
        );
      }
    },
  };
}

export interface PoolCreateDeps {
  /** Raw block device access for the label partitions. Tests inject a fake. */
  readonly labelIo?: BlockDeviceIo;
  /** Where the mdadm config file goes. The default is the system directory. */
  readonly mdadmConfDir?: string;
  /** Clock for the labels' writtenAt. */
  readonly now?: () => string;
}

/** The steps that create the pool described by `input`. Pure: nothing is read or written here. */
export function buildPoolCreateJob(
  input: PoolCreateInput,
  deps: PoolCreateDeps = {},
): JobDefinition {
  const resolved: Deps = {
    labelIo: deps.labelIo ?? blockDeviceIo,
    mdadmConfDir: deps.mdadmConfDir,
    now: deps.now ?? (() => new Date().toISOString()),
  };
  const { poolId } = input;
  const steps: StepDefinition[] = [
    ...input.drives.map((drive) =>
      partitionStep({
        path: drive.path,
        poolId,
        partitions: plannedDrive(input, drive.path).partitions,
        wipe: input.wipe,
      }),
    ),
    ...input.drives.map((drive) =>
      labelStep(
        {
          path: drive.path,
          poolId,
          poolUuid: input.poolUuid,
          driveUuid: drive.driveUuid,
          redundancy: input.redundancy,
          wipe: input.wipe,
        },
        resolved,
      ),
    ),
    ...input.layout.tiers.map((tier) => arrayStep(poolId, tierSpec(tier))),
    ...input.layout.tiers.map((tier) => physicalVolumeStep(poolId, tier.tier)),
    volumeGroupStep(input),
    mdadmConfStep(
      poolId,
      input.layout.tiers.map((tier) => tier.tier),
      resolved.mdadmConfDir,
    ),
  ];
  return { kind: 'pool-create', poolId: input.poolId, input, steps };
}
