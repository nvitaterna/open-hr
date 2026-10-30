/**
 * The volume-grow job (decision 0011): extend a volume with lvextend, to
 * all free space or to a given size, then grow its mounted filesystem
 * online. pool-expand appends the same steps when asked to grow a volume
 * into the space it adds. Encrypted volumes and cryptsetup resize come in
 * M6.
 */

import { realpath } from 'node:fs/promises';

import { volumeGroupName } from '@ohr/shared/naming';
import { LV_FIELDS, lvmReportArgs, parseLvs, parseVgs, VG_FIELDS } from '@ohr/shared/parsers/lvm';
import type { VolumeGrowInput, VolumeGrowTarget } from '@ohr/shared/volume-grow-input';

import type { CommandRunner } from '../command-runner.ts';
import { growFilesystem, growFilesystemCommand } from '../executors/grow-filesystem.ts';
import { extendLogicalVolume, logicalVolumePath, lvextendArgs } from '../executors/lvm.ts';
import { readMount } from '../executors/mount.ts';
import { formatCommand, type JobDefinition, type StepDefinition } from './engine.ts';
import { alreadyDone, blocked, READY } from './pool-steps.ts';

async function volumeBytes(
  run: CommandRunner,
  poolId: string,
  name: string,
): Promise<number | null> {
  const result = await run('lvs', [
    ...lvmReportArgs(LV_FIELDS),
    `${volumeGroupName(poolId)}/${name}`,
  ]);
  if (result.kind !== 'exited' || result.exitCode !== 0) {
    return null;
  }
  return parseLvs(result.stdout)[0]?.sizeBytes ?? null;
}

async function freeBytes(run: CommandRunner, poolId: string): Promise<number | null> {
  const result = await run('vgs', [...lvmReportArgs(VG_FIELDS), volumeGroupName(poolId)]);
  if (result.kind !== 'exited' || result.exitCode !== 0) {
    return null;
  }
  return parseVgs(result.stdout)[0]?.freeBytes ?? null;
}

function extendStep(poolId: string, target: VolumeGrowTarget): StepDefinition {
  const request = { poolId, name: target.name, size: target.size };
  const done = async (run: CommandRunner): Promise<boolean> => {
    if (target.size.kind === 'bytes') {
      return (await volumeBytes(run, poolId, target.name)) === target.size.bytes;
    }
    return (await freeBytes(run, poolId)) === 0;
  };
  return {
    name: `extend volume ${target.name}`,
    description: `Grow ${logicalVolumePath(poolId, target.name)} into the pool's free space`,
    commands: [formatCommand('lvextend', lvextendArgs(request))],
    async precondition({ run }) {
      const size = await volumeBytes(run, poolId, target.name);
      if (size === null) {
        return blocked(`Pool ${poolId} has no volume ${target.name}`);
      }
      if (await done(run)) {
        return alreadyDone(`${target.name} already has the space`);
      }
      if (target.size.kind === 'bytes' && size > target.size.bytes) {
        return blocked(`${target.name} is already larger than ${target.size.bytes} bytes`);
      }
      return READY;
    },
    async action({ run }) {
      await extendLogicalVolume(run, request);
    },
    async postcondition({ run }) {
      if (!(await done(run))) {
        throw new Error(`${target.name} did not get the space after lvextend`);
      }
    },
  };
}

function growFilesystemStep(
  poolId: string,
  target: VolumeGrowTarget,
  resolvePath: (path: string) => Promise<string>,
): StepDefinition {
  const device = logicalVolumePath(poolId, target.name);
  const request = { device, type: target.filesystem, mountPoint: target.mountPoint };
  const { command, args } = growFilesystemCommand(request);
  const mounted = async (run: CommandRunner): Promise<boolean> => {
    const mount = await readMount(run, target.mountPoint).catch(() => null);
    return mount !== null && (await resolvePath(mount.device)) === (await resolvePath(device));
  };
  return {
    name: `grow filesystem of ${target.name}`,
    description: `Grow the ${target.filesystem} filesystem at ${target.mountPoint} to fill its volume, online`,
    commands: [formatCommand(command, args)],
    // Growing a filesystem that already fills its volume changes nothing, so this always runs.
    async precondition({ run }) {
      if (!(await mounted(run))) {
        return blocked(`${device} is not mounted at ${target.mountPoint}`);
      }
      return READY;
    },
    async action({ run }) {
      await growFilesystem(run, request);
    },
    async postcondition({ run }) {
      if (!(await mounted(run))) {
        throw new Error(`${device} is not mounted at ${target.mountPoint} after the grow`);
      }
    },
  };
}

export interface VolumeGrowDeps {
  /** Resolves device symlinks, for comparing a mount's source to the volume. Tests inject identity. */
  readonly resolvePath?: (path: string) => Promise<string>;
}

/** The two steps that grow a volume and its filesystem. */
export function volumeGrowSteps(
  poolId: string,
  target: VolumeGrowTarget,
  deps: VolumeGrowDeps = {},
): StepDefinition[] {
  const resolvePath = deps.resolvePath ?? ((path) => realpath(path));
  return [extendStep(poolId, target), growFilesystemStep(poolId, target, resolvePath)];
}

/** The steps that grow the volume described by `input`. Pure: nothing is read or written here. */
export function buildVolumeGrowJob(
  input: VolumeGrowInput,
  deps: VolumeGrowDeps = {},
): JobDefinition {
  return {
    kind: 'volume-grow',
    poolId: input.poolId,
    input,
    steps: volumeGrowSteps(input.poolId, input, deps),
  };
}
