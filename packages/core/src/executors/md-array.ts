/**
 * Creates one tier's md array with mdadm (plan section 4.1): metadata 1.2, an
 * internal write-intent bitmap, and a 512 KiB chunk on parity levels.
 * Destructive: it writes superblocks over the member partitions. The caller
 * checks the members are free first; this only carries out the plan.
 */

import type { RaidLevel } from '@ohr/shared/array-capacity';
import { MD_CHUNK_BYTES } from '@ohr/shared/constants';
import { mdArrayName } from '@ohr/shared/naming';
import { type MdDetail, parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';

import { type CommandRunner, runChecked } from '../command-runner.ts';

const BYTES_PER_KIB = 1024;
const MD_METADATA = '1.2';
/**
 * Stored in the superblock in place of a hostname, so the array assembles
 * under its own name on any machine, for example after the drives move
 * (decision 0004).
 */
const MD_HOMEHOST = 'any';
/** Fewest members mdadm accepts per level. The planner never asks for less. */
const MIN_MEMBERS: Readonly<Record<RaidLevel, number>> = { raid1: 2, raid5: 3, raid6: 4 };
/** Writing superblocks and starting the array can be slow on sleeping drives. */
const MDADM_TIMEOUT_MS = 120_000;

export interface CreateArrayRequest {
  readonly poolId: string;
  /** Tier number, starting at 1. */
  readonly tier: number;
  readonly level: RaidLevel;
  /** Partition paths, one per member, in slot order. */
  readonly members: readonly string[];
}

/** Path mdadm gives a tier's array, such as /dev/md/ohr_p1_t1. */
export function mdArrayPath(poolId: string, tier: number): string {
  return `/dev/md/${mdArrayName(poolId, tier)}`;
}

/**
 * mdadm arguments that create the array. `--run` answers mdadm's question
 * about old signatures on the members, which it would otherwise ask on stdin
 * and abort. The members were wiped when they were partitioned, and the
 * signature check that protects a user's data happens before the job starts.
 */
export function mdadmCreateArgs(request: CreateArrayRequest): string[] {
  const { level, members } = request;
  if (members.length < MIN_MEMBERS[level]) {
    throw new RangeError(
      `${level} needs at least ${MIN_MEMBERS[level]} members, got ${members.length}`,
    );
  }
  const name = mdArrayName(request.poolId, request.tier);
  const args = [
    '--create',
    `/dev/md/${name}`,
    '--run',
    `--metadata=${MD_METADATA}`,
    `--homehost=${MD_HOMEHOST}`,
    `--name=${name}`,
    `--level=${level}`,
    `--raid-devices=${members.length}`,
    '--bitmap=internal',
  ];
  if (level !== 'raid1') {
    // mdadm refuses a chunk size on RAID1.
    args.push(`--chunk=${MD_CHUNK_BYTES / BYTES_PER_KIB}`);
  }
  args.push(...members);
  return args;
}

/**
 * Creates the array, waits for udev to create its /dev/md link, and returns
 * what mdadm reports about it. A parity array starts rebuilding its last
 * member in the background and is usable right away.
 */
export async function createArray(
  run: CommandRunner,
  request: CreateArrayRequest,
): Promise<MdDetail> {
  await runChecked(run, 'mdadm', mdadmCreateArgs(request), { timeoutMs: MDADM_TIMEOUT_MS });
  await runChecked(run, 'udevadm', ['settle']);
  const path = mdArrayPath(request.poolId, request.tier);
  return parseMdadmDetail(await runChecked(run, 'mdadm', ['--detail', '--export', path]));
}
