/**
 * Steps that reshape a tier's array (decision 0011): convert it to RAID5,
 * add members, grow it onto them, and set the chunk. The wait for md is in
 * wait-step.ts. Each
 * precondition reads the live array, so after a crash the step whose work
 * already happened is skipped and a wait attaches to the reshape the kernel
 * kept running.
 */

import { MD_CHUNK_BYTES } from '@ohr/shared/constants';
import { type MdDetail, parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';

import type { CommandRunner, FileReader } from '../command-runner.ts';
import { mdArrayPath } from '../executors/md-array.ts';
import {
  addMembers,
  convertToRaid5,
  growDevices,
  mdadmAddArgs,
  mdadmChunkArgs,
  mdadmConvertToRaid5Args,
  mdadmGrowDevicesArgs,
  setChunk,
} from '../executors/md-reshape.ts';
import { readSyncState } from '../executors/md-sync.ts';
import { formatCommand, type StepDefinition } from './engine.ts';
import { alreadyDone, blocked, READY } from './pool-steps.ts';

/** A converted tier needs this many members before its chunk can change (decision 0011). */
const CHUNK_CHANGE_MIN_MEMBERS = 3;
const NUMBERS = /\d+/gu;
/** mdadm can return before md shows the new chunk. How long to keep looking for it. */
const CHUNK_SHOWN_TIMEOUT_MS = 30_000;
const CHUNK_SHOWN_INTERVAL_MS = 500;

async function readDetail(run: CommandRunner, path: string): Promise<MdDetail | null> {
  const result = await run('mdadm', ['--detail', '--export', path]);
  if (result.kind !== 'exited' || result.exitCode !== 0) {
    return null;
  }
  return parseMdadmDetail(result.stdout);
}

async function requireDetail(run: CommandRunner, path: string): Promise<MdDetail> {
  const detail = await readDetail(run, path);
  if (detail === null) {
    throw new Error(`${path} is not running`);
  }
  return detail;
}

/** Why the array must not be changed now, or null: it is busy, or degraded. */
async function arrayProblem(deps: MdDeps, path: string): Promise<string | null> {
  const state = await readSyncState(deps.files, await deps.kernelName(path));
  if (state.kind === 'busy') {
    return `${path} is running a ${state.progress.operation}`;
  }
  if (state.degraded) {
    return `${path} is degraded. Replace the missing drive first`;
  }
  return null;
}

/** The chunk the array has, or is changing to, in bytes. "65536 (524288)" is mid-change. */
async function targetChunk(deps: MdDeps, path: string): Promise<number | null> {
  const text = await deps.files(`/sys/block/${await deps.kernelName(path)}/md/chunk_size`);
  const last = text?.match(NUMBERS)?.at(-1);
  if (last === undefined) {
    return null;
  }
  return Number(last);
}

/** True once md shows the 512 KiB chunk, now or as the target of a change, before `deadline`. */
async function chunkShown(deps: MdDeps, path: string, deadline: number): Promise<boolean> {
  if ((await targetChunk(deps, path)) === MD_CHUNK_BYTES) {
    return true;
  }
  if (Date.now() >= deadline) {
    return false;
  }
  await deps.delay(CHUNK_SHOWN_INTERVAL_MS);
  return chunkShown(deps, path, deadline);
}

/** What the md steps read besides commands. Tests replace them. */
export interface MdDeps {
  readonly files: FileReader;
  /** The kernel name behind an array path, such as md127. */
  readonly kernelName: (path: string) => Promise<string>;
  /** How often a wait step reads the array's state. */
  readonly pollIntervalMs: number | undefined;
  /** Pauses between reads. Tests make it instant. */
  readonly delay: (ms: number) => Promise<void>;
}

export function convertStep(poolId: string, tier: number, deps: MdDeps): StepDefinition {
  const path = mdArrayPath(poolId, tier);
  return {
    name: `convert tier ${tier} to RAID5`,
    description: `Turn the two-member RAID1 ${path} into a RAID5 in place`,
    commands: [formatCommand('mdadm', mdadmConvertToRaid5Args(path))],
    async precondition({ run }) {
      const detail = await readDetail(run, path);
      if (detail === null) {
        return blocked(`${path} is not running`);
      }
      if (detail.level === 'raid5') {
        return alreadyDone(`${path} is already RAID5`);
      }
      if (detail.level !== 'raid1' || detail.raidDevices !== 2) {
        return blocked(`${path} is ${detail.level} with ${detail.raidDevices} members`);
      }
      const problem = await arrayProblem(deps, path);
      if (problem !== null) {
        return blocked(problem);
      }
      return READY;
    },
    async action({ run }) {
      await convertToRaid5(run, path);
    },
    async postcondition({ run }) {
      const detail = await requireDetail(run, path);
      if (detail.level !== 'raid5') {
        throw new Error(`${path} is ${detail.level} after the conversion`);
      }
    },
  };
}

export function addMembersStep(
  poolId: string,
  tier: { readonly tier: number; readonly partitions: readonly string[] },
  deps: MdDeps,
): StepDefinition {
  const path = mdArrayPath(poolId, tier.tier);
  const missing = (detail: MdDetail): string[] =>
    tier.partitions.filter((partition) => !detail.members.some((m) => m.device === partition));
  return {
    name: `add members to tier ${tier.tier}`,
    description: `Add ${tier.partitions.join(', ')} to ${path} as spares`,
    commands: [formatCommand('mdadm', mdadmAddArgs(path, tier.partitions))],
    async precondition({ run }) {
      const detail = await readDetail(run, path);
      if (detail === null) {
        return blocked(`${path} is not running`);
      }
      if (missing(detail).length === 0) {
        return alreadyDone(`${path} already has the new members`);
      }
      // On a degraded array a new member would rebuild a missing one instead of growing it.
      const problem = await arrayProblem(deps, path);
      if (problem !== null) {
        return blocked(problem);
      }
      return READY;
    },
    async action({ run }) {
      const members = missing(await requireDetail(run, path));
      await addMembers(run, { array: path, members });
    },
    async postcondition({ run }) {
      const left = missing(await requireDetail(run, path));
      if (left.length > 0) {
        throw new Error(`${path} does not have ${left.join(', ')}`);
      }
    },
  };
}

export function growStep(
  poolId: string,
  tier: { readonly tier: number; readonly members: number },
  deps: MdDeps,
): StepDefinition {
  const path = mdArrayPath(poolId, tier.tier);
  return {
    name: `grow tier ${tier.tier} to ${tier.members} members`,
    description: `Reshape ${path} onto its new members. This runs in the background and can take hours`,
    commands: [formatCommand('mdadm', mdadmGrowDevicesArgs(path, tier.members))],
    async precondition({ run }) {
      const detail = await readDetail(run, path);
      if (detail === null) {
        return blocked(`${path} is not running`);
      }
      if (detail.raidDevices === tier.members) {
        return alreadyDone(`${path} already has ${tier.members} members`);
      }
      if (detail.raidDevices > tier.members) {
        return blocked(`${path} has ${detail.raidDevices} members, more than planned`);
      }
      const spares = detail.members.filter((member) => member.role === 'spare').length;
      if (detail.raidDevices + spares < tier.members) {
        return blocked(`${path} has ${spares} spares, too few to grow to ${tier.members}`);
      }
      const problem = await arrayProblem(deps, path);
      if (problem !== null) {
        return blocked(problem);
      }
      return READY;
    },
    async action({ run }) {
      await growDevices(run, { array: path, raidDevices: tier.members });
    },
    async postcondition({ run }) {
      const detail = await requireDetail(run, path);
      if (detail.raidDevices !== tier.members) {
        throw new Error(`${path} has ${detail.raidDevices} members after the grow`);
      }
    },
  };
}

export function chunkStep(poolId: string, tier: number, deps: MdDeps): StepDefinition {
  const path = mdArrayPath(poolId, tier);
  return {
    name: `set tier ${tier} chunk`,
    description: `Reshape ${path} to the 512 KiB chunk. This runs in the background and can take hours`,
    commands: [formatCommand('mdadm', mdadmChunkArgs(path))],
    async precondition({ run }) {
      if ((await targetChunk(deps, path)) === MD_CHUNK_BYTES) {
        return alreadyDone(`${path} already has, or is changing to, the 512 KiB chunk`);
      }
      const detail = await readDetail(run, path);
      if (detail === null) {
        return blocked(`${path} is not running`);
      }
      // On two members, a chunk change under writes deadlocks the kernel (decision 0011).
      if (detail.raidDevices < CHUNK_CHANGE_MIN_MEMBERS) {
        return blocked(
          `${path} has ${detail.raidDevices} members; its chunk changes after it grows`,
        );
      }
      const problem = await arrayProblem(deps, path);
      if (problem !== null) {
        return blocked(problem);
      }
      return READY;
    },
    async action({ run }) {
      await setChunk(run, path);
    },
    async postcondition() {
      if (!(await chunkShown(deps, path, Date.now() + CHUNK_SHOWN_TIMEOUT_MS))) {
        throw new Error(`${path} is not changing to the 512 KiB chunk`);
      }
    },
  };
}
