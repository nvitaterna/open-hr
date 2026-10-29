/**
 * The volume-create job (plan section 4.3): a logical volume in the pool's
 * group, a filesystem on it, and a systemd mount unit that mounts it now
 * and at boot. Each precondition reads the live system so the job resumes
 * and re-runs safely.
 */

import { realpath } from 'node:fs/promises';

import { volumeGroupName } from '@ohr/shared/naming';
import { LV_FIELDS, lvmReportArgs, parseLvs } from '@ohr/shared/parsers/lvm';
import type { VolumeCreateInput } from '@ohr/shared/volume-create-input';

import type { CommandRunner } from '../command-runner.ts';
import {
  filesystemLabel,
  makeFilesystem,
  mkfsCommand,
  readFilesystem,
} from '../executors/filesystem.ts';
import { createLogicalVolume, logicalVolumePath, lvcreateArgs } from '../executors/lvm.ts';
import { assertMountPoint, readMount } from '../executors/mount.ts';
import { installMountUnit, mountUnitPath, type UnitScope } from '../executors/mount-unit.ts';
import {
  formatCommand,
  type JobDefinition,
  type Precondition,
  type StepDefinition,
} from './engine.ts';

const READY: Precondition = { kind: 'ready' };
/** blkid exits with this when it finds no signature at all. */
const BLKID_NOTHING_FOUND = 2;

interface Deps {
  readonly unitScope: UnitScope;
  readonly resolvePath: (path: string) => Promise<string>;
}

function blocked(reason: string): Precondition {
  return { kind: 'blocked', reason };
}

function alreadyDone(detail: string): Precondition {
  return { kind: 'already-done', detail };
}

function volumeStep(input: VolumeCreateInput): StepDefinition {
  const group = volumeGroupName(input.poolId);
  const target = `${group}/${input.name}`;
  const request = { poolId: input.poolId, name: input.name, size: input.size };
  return {
    name: `create volume ${input.name}`,
    description: `Create logical volume ${target}`,
    commands: [formatCommand('lvcreate', lvcreateArgs(request)), 'udevadm settle'],
    async precondition({ run }) {
      const result = await run('lvs', [...lvmReportArgs(LV_FIELDS), target]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        return READY;
      }
      const [volume] = parseLvs(result.stdout);
      if (volume === undefined) {
        return READY;
      }
      if (input.size.kind === 'bytes' && volume.sizeBytes !== input.size.bytes) {
        return blocked(
          `${target} already exists with ${volume.sizeBytes} bytes, not ${input.size.bytes}`,
        );
      }
      return alreadyDone(`${target} already exists`);
    },
    async action({ run }) {
      await createLogicalVolume(run, request);
    },
    async postcondition({ run }) {
      const result = await run('lvs', [...lvmReportArgs(LV_FIELDS), target]);
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        throw new Error(`${target} is not there after lvcreate`);
      }
    },
  };
}

function formatStep(input: VolumeCreateInput): StepDefinition {
  const device = logicalVolumePath(input.poolId, input.name);
  const request = { device, type: input.filesystem, name: input.name };
  const { command, args } = mkfsCommand(request);
  const commands = [formatCommand(command, args)];
  if (input.filesystem === 'btrfs') {
    commands.push(
      `mount -t btrfs ${device} <scratch>`,
      'btrfs subvolume create <scratch>/@data',
      'btrfs subvolume create <scratch>/.snapshots',
      'umount <scratch>',
    );
  }
  return {
    name: `format ${input.name}`,
    description: `Make a ${input.filesystem} filesystem on ${device}`,
    commands,
    async precondition({ run }) {
      const result = await run('blkid', ['-o', 'export', device]);
      if (result.kind === 'exited' && result.exitCode === BLKID_NOTHING_FOUND) {
        return READY;
      }
      if (result.kind !== 'exited' || result.exitCode !== 0) {
        return blocked(`${device} cannot be read`);
      }
      const found = await readFilesystem(run, device).catch(() => null);
      if (found === null) {
        return blocked(`${device} holds something that is not btrfs or ext4`);
      }
      if (found.type !== input.filesystem) {
        return blocked(`${device} already holds ${found.type}, not ${input.filesystem}`);
      }
      if (found.label !== filesystemLabel(input.filesystem, input.name)) {
        return blocked(`${device} already holds ${found.type} labelled "${found.label}"`);
      }
      return alreadyDone(`${device} already holds ${found.type} "${found.label}"`);
    },
    async action({ run }) {
      await makeFilesystem(run, request);
    },
    async postcondition({ run }) {
      const found = await readFilesystem(run, device);
      if (found.type !== input.filesystem) {
        throw new Error(`${device} holds ${found.type} after making ${input.filesystem}`);
      }
    },
  };
}

function mountStep(input: VolumeCreateInput, deps: Deps): StepDefinition {
  assertMountPoint(input.mountPoint);
  const device = logicalVolumePath(input.poolId, input.name);
  const unitPath = mountUnitPath(input.mountPoint, deps.unitScope);
  const request = {
    poolId: input.poolId,
    volume: input.name,
    device,
    type: input.filesystem,
    mountPoint: input.mountPoint,
  };
  const sameDevice = async (run: CommandRunner): Promise<boolean | null> => {
    const mount = await readMount(run, input.mountPoint).catch(() => null);
    if (mount === null) {
      return null;
    }
    return (await deps.resolvePath(mount.device)) === (await deps.resolvePath(device));
  };
  return {
    name: `mount ${input.name}`,
    description: `Mount ${device} at ${input.mountPoint} now and at boot`,
    commands: [
      `write ${unitPath}`,
      'systemctl daemon-reload',
      formatCommand('systemctl', [
        'enable',
        '--now',
        `${input.mountPoint.slice(1).replaceAll('/', '-')}.mount`,
      ]),
    ],
    async precondition({ run }) {
      const same = await sameDevice(run);
      if (same === null) {
        return READY;
      }
      if (same) {
        return alreadyDone(`${device} is already mounted at ${input.mountPoint}`);
      }
      return blocked(`${input.mountPoint} has something else mounted on it`);
    },
    async action({ run }) {
      await installMountUnit(run, request, deps.unitScope);
    },
    async postcondition({ run }) {
      if ((await sameDevice(run)) !== true) {
        throw new Error(`${device} is not mounted at ${input.mountPoint}`);
      }
    },
  };
}

export interface VolumeCreateDeps {
  /** Where the mount unit goes. Tests use runtime so nothing lands in /etc. */
  readonly unitScope?: UnitScope;
  /** Resolves device symlinks, for comparing a mount's source to the volume. Tests inject identity. */
  readonly resolvePath?: (path: string) => Promise<string>;
}

/** The steps that create the volume described by `input`. Pure: nothing is read or written here. */
export function buildVolumeCreateJob(
  input: VolumeCreateInput,
  deps: VolumeCreateDeps = {},
): JobDefinition {
  const resolved: Deps = {
    unitScope: deps.unitScope ?? 'persistent',
    resolvePath: deps.resolvePath ?? ((path) => realpath(path)),
  };
  return {
    kind: 'volume-create',
    poolId: input.poolId,
    input,
    steps: [volumeStep(input), formatStep(input), mountStep(input, resolved)],
  };
}
