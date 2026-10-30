/**
 * Steps that more than one pool job builds (decisions 0006 and 0011):
 * create a tier's array, make it a physical volume, and record the pool's
 * arrays for mdadm. Each precondition reads the live system, so a job can
 * resume and re-run. Steps for a drive joining a pool are in drive-steps.ts.
 */

import { readFile } from 'node:fs/promises';

import type { RaidLevel } from '@ohr/shared/array-capacity';
import { mdArrayName, volumeGroupName } from '@ohr/shared/naming';
import { lvmReportArgs, PV_FIELDS, parsePvs } from '@ohr/shared/parsers/lvm';
import { parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';
import type { MdArrayDefinition } from '@ohr/shared/parsers/mdadm-scan';

import type { CommandRunner } from '../command-runner.ts';
import { createPhysicalVolume } from '../executors/lvm.ts';
import { createArray, mdArrayPath, mdadmCreateArgs } from '../executors/md-array.ts';
import {
  arrayDefinition,
  mdadmConfPath,
  renderMdadmConf,
  writeMdadmConf,
} from '../executors/mdadm-conf.ts';
import { partitionPath } from '../executors/partition-drive.ts';
import { formatCommand, type Precondition, type StepDefinition } from './engine.ts';

async function currentFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export function tierMembers(tier: TierSpec): string[] {
  return tier.members.map((drive) => partitionPath(drive, tier.partitionNumber));
}

export function arrayStep(poolId: string, tier: TierSpec): StepDefinition {
  const members = tierMembers(tier);
  const request = { poolId, tier: tier.tier, level: tier.level, members };
  const path = mdArrayPath(poolId, tier.tier);
  return {
    name: `create tier ${tier.tier} array`,
    description: `Create ${tier.level} array ${mdArrayName(poolId, tier.tier)} from ${members.length} partitions`,
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

export function physicalVolumeStep(poolId: string, tier: number): StepDefinition {
  const path = mdArrayPath(poolId, tier);
  const group = volumeGroupName(poolId);
  return {
    name: `add tier ${tier} array to LVM`,
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

export function mdadmConfStep(
  poolId: string,
  tiers: readonly number[],
  confDir: string | undefined,
): StepDefinition {
  const options = { confDir };
  const confPath = mdadmConfPath(poolId, options);
  const arrays = tiers.map((tier) => mdArrayPath(poolId, tier));
  const definitions = (run: CommandRunner): Promise<MdArrayDefinition[]> =>
    Promise.all(arrays.map((path) => arrayDefinition(run, path)));
  return {
    name: 'write mdadm config',
    description: `Record the arrays in ${confPath}`,
    commands: [formatCommand('mdadm', ['--detail', '--scan', ...arrays]), `write ${confPath}`],
    async precondition({ run }) {
      const expected = renderMdadmConf(poolId, await definitions(run));
      if ((await currentFile(confPath)) === expected) {
        return alreadyDone(`${confPath} is up to date`);
      }
      return READY;
    },
    async action({ run }) {
      await writeMdadmConf(poolId, await definitions(run), options);
    },
    async postcondition({ run }) {
      const expected = renderMdadmConf(poolId, await definitions(run));
      if ((await currentFile(confPath)) !== expected) {
        throw new Error(`${confPath} does not hold the expected arrays`);
      }
    },
  };
}

export const READY: Precondition = { kind: 'ready' };

export function blocked(reason: string): Precondition {
  return { kind: 'blocked', reason };
}

export function alreadyDone(detail: string): Precondition {
  return { kind: 'already-done', detail };
}

/** A tier's array as a job creates it: member drives and the partition number they share. */
export interface TierSpec {
  readonly tier: number;
  readonly level: RaidLevel;
  readonly partitionNumber: number;
  /** Drive paths, in slot order. */
  readonly members: readonly string[];
}
