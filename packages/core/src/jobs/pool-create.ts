/**
 * The pool-create job (plan section 4.2): partition every drive, write the
 * labels, create one array per tier, put the arrays under one volume group,
 * and record the arrays for mdadm. Each step's precondition reads the live
 * system, so the job can be resumed and re-run safely. Volumes are a
 * separate job.
 */

import { readFile } from 'node:fs/promises';

import {
  labelPartitionLabel,
  mdArrayName,
  tierPartitionLabel,
  volumeGroupName,
} from '@ohr/shared/naming';
import { type BlockDevice, LSBLK_COLUMNS, parseLsblk } from '@ohr/shared/parsers/lsblk';
import { lvmReportArgs, PV_FIELDS, parsePvs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import { parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';
import type { MdArrayDefinition } from '@ohr/shared/parsers/mdadm-scan';
import type { PlannedDrive, PlannedPartition, PlannedTier } from '@ohr/shared/planner';
import type { PoolCreateDrive, PoolCreateInput } from '@ohr/shared/pool-create-input';
import type { DriveRole } from '@ohr/shared/system-snapshot';

import type { CommandRunner } from '../command-runner.ts';
import { driveRole } from '../drive-roles.ts';
import {
  type BlockDeviceIo,
  blockDeviceIo,
  readLabel,
  writeLabel,
} from '../executors/label-partition.ts';
import { createPhysicalVolume, createVolumeGroup, vgcreateArgs } from '../executors/lvm.ts';
import { createArray, mdArrayPath, mdadmCreateArgs } from '../executors/md-array.ts';
import {
  arrayDefinition,
  mdadmConfPath,
  renderMdadmConf,
  writeMdadmConf,
} from '../executors/mdadm-conf.ts';
import { partitionDrive, partitionPath, sgdiskArgs } from '../executors/partition-drive.ts';
import {
  formatCommand,
  type JobDefinition,
  type Precondition,
  type StepDefinition,
} from './engine.ts';

const LABEL_PARTITION_NUMBER = 1;
const READY: Precondition = { kind: 'ready' };
/** lsblk types for a whole device. Loop devices are what the integration tests use. */
const WHOLE_DEVICE_TYPES: ReadonlySet<string> = new Set(['disk', 'loop']);

interface Deps {
  readonly labelIo: BlockDeviceIo;
  readonly mdadmConfDir: string | undefined;
  readonly now: () => string;
}

function blocked(reason: string): Precondition {
  return { kind: 'blocked', reason };
}

function alreadyDone(detail: string): Precondition {
  return { kind: 'already-done', detail };
}

function plannedDrive(input: PoolCreateInput, path: string): PlannedDrive {
  const drive = input.layout.drives.find((candidate) => candidate.id === path);
  if (drive === undefined) {
    throw new Error(`${path} is not in the planned layout`);
  }
  return drive;
}

function expectedLabel(poolId: string, partition: PlannedPartition): string {
  if (partition.tier === null) {
    return labelPartitionLabel(poolId);
  }
  return tierPartitionLabel(poolId, partition.tier);
}

/** True when the drive carries exactly the planned partitions with their names. */
function matchesPlan(device: BlockDevice, poolId: string, planned: PlannedDrive): boolean {
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

interface FoundDrive {
  readonly device: BlockDevice;
  readonly role: DriveRole;
}

/** The drive as lsblk sees it right now, or null if it is not there. Asks for that device only. */
async function findDrive(run: CommandRunner, path: string): Promise<FoundDrive | null> {
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

function partitionStep(input: PoolCreateInput, drive: PoolCreateDrive): StepDefinition {
  const planned = plannedDrive(input, drive.path);
  const request = { devicePath: drive.path, poolId: input.poolId, partitions: planned.partitions };
  const paths = planned.partitions.map((partition) => partitionPath(drive.path, partition.number));
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
      if (matchesPlan(found.device, input.poolId, planned)) {
        return alreadyDone(`${drive.path} already has the planned partitions`);
      }
      if (found.role !== 'empty' && !input.wipe) {
        return blocked(`${drive.path} is not empty and wiping was not chosen`);
      }
      return READY;
    },
    async action({ run }) {
      await partitionDrive(run, request);
    },
    async postcondition({ run }) {
      const found = await findDrive(run, drive.path);
      if (found === null || !matchesPlan(found.device, input.poolId, planned)) {
        throw new Error(`${drive.path} does not show the planned partitions`);
      }
    },
  };
}

function labelStep(input: PoolCreateInput, drive: PoolCreateDrive, deps: Deps): StepDefinition {
  const partition = partitionPath(drive.path, LABEL_PARTITION_NUMBER);
  const fields = {
    poolId: input.poolId,
    poolUuid: input.poolUuid,
    driveUuid: drive.driveUuid,
    redundancy: input.redundancy,
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
        label.descriptor.poolUuid === input.poolUuid &&
        label.descriptor.driveUuid === drive.driveUuid
      ) {
        return alreadyDone(`${partition} already holds this drive's label`);
      }
      if (!input.wipe) {
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

function tierMembers(tier: PlannedTier): string[] {
  return tier.members.map((drive) => partitionPath(drive, tier.partitionNumber));
}

function arrayStep(input: PoolCreateInput, tier: PlannedTier): StepDefinition {
  const members = tierMembers(tier);
  const request = { poolId: input.poolId, tier: tier.tier, level: tier.level, members };
  const path = mdArrayPath(input.poolId, tier.tier);
  return {
    name: `create tier ${tier.tier} array`,
    description: `Create ${tier.level} array ${mdArrayName(input.poolId, tier.tier)} from ${members.length} partitions`,
    commands: [formatCommand('mdadm', mdadmCreateArgs(request)), 'udevadm settle'],
    async precondition({ run }) {
      const result = await run('mdadm', ['--detail', '--export', path]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        return READY;
      }
      const detail = parseMdadmDetail(result.stdout);
      const actual = detail.members
        .map((member) => member.device)
        .sort((a, b) => a.localeCompare(b));
      if (actual.join(',') === [...members].sort((a, b) => a.localeCompare(b)).join(',')) {
        return alreadyDone(`${path} already exists with the planned members`);
      }
      return blocked(`${path} exists with other members: ${actual.join(', ')}`);
    },
    async action({ run }) {
      await createArray(run, request);
    },
    async postcondition({ run }) {
      const result = await run('mdadm', ['--detail', '--export', path]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        throw new Error(`${path} is not there after creation`);
      }
      const detail = parseMdadmDetail(result.stdout);
      if (detail.level !== tier.level || detail.raidDevices !== members.length) {
        throw new Error(
          `${path} is ${detail.level} with ${detail.raidDevices} devices, not ${tier.level} with ${members.length}`,
        );
      }
    },
  };
}

function physicalVolumeStep(input: PoolCreateInput, tier: PlannedTier): StepDefinition {
  const path = mdArrayPath(input.poolId, tier.tier);
  const group = volumeGroupName(input.poolId);
  return {
    name: `add tier ${tier.tier} array to LVM`,
    description: `Make ${path} a physical volume`,
    commands: [
      formatCommand('wipefs', ['--all', '--quiet', path]),
      formatCommand('pvcreate', [path]),
    ],
    async precondition({ run }) {
      const result = await run('pvs', [...lvmReportArgs(PV_FIELDS), path]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        return READY;
      }
      const [volume] = parsePvs(result.stdout);
      if (volume === undefined) {
        return READY;
      }
      if (volume.volumeGroup === null || volume.volumeGroup === group) {
        return alreadyDone(`${path} is already a physical volume`);
      }
      return blocked(`${path} belongs to volume group ${volume.volumeGroup}`);
    },
    async action({ run }) {
      await createPhysicalVolume(run, path);
    },
    async postcondition({ run }) {
      const result = await run('pvs', [...lvmReportArgs(PV_FIELDS), path]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        throw new Error(`${path} is not a physical volume after pvcreate`);
      }
    },
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

async function currentFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

function mdadmConfStep(input: PoolCreateInput, deps: Deps): StepDefinition {
  const options = { confDir: deps.mdadmConfDir };
  const confPath = mdadmConfPath(input.poolId, options);
  const arrays = input.layout.tiers.map((tier) => mdArrayPath(input.poolId, tier.tier));
  const definitions = (run: CommandRunner): Promise<MdArrayDefinition[]> =>
    Promise.all(arrays.map((path) => arrayDefinition(run, path)));
  return {
    name: 'write mdadm config',
    description: `Record the arrays in ${confPath}`,
    commands: [formatCommand('mdadm', ['--detail', '--scan', ...arrays]), `write ${confPath}`],
    async precondition({ run }) {
      const expected = renderMdadmConf(input.poolId, await definitions(run));
      if ((await currentFile(confPath)) === expected) {
        return alreadyDone(`${confPath} is up to date`);
      }
      return READY;
    },
    async action({ run }) {
      await writeMdadmConf(input.poolId, await definitions(run), options);
    },
    async postcondition({ run }) {
      const expected = renderMdadmConf(input.poolId, await definitions(run));
      if ((await currentFile(confPath)) !== expected) {
        throw new Error(`${confPath} does not hold the expected arrays`);
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
  const steps: StepDefinition[] = [
    ...input.drives.map((drive) => partitionStep(input, drive)),
    ...input.drives.map((drive) => labelStep(input, drive, resolved)),
    ...input.layout.tiers.map((tier) => arrayStep(input, tier)),
    ...input.layout.tiers.map((tier) => physicalVolumeStep(input, tier)),
    volumeGroupStep(input),
    mdadmConfStep(input, resolved),
  ];
  return { kind: 'pool-create', poolId: input.poolId, input, steps };
}
