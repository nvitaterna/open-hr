/**
 * Changes a running tier array with mdadm (decision 0011): adds members,
 * grows the member count, converts a two-member RAID1 to RAID5 and sets its
 * chunk, swaps a member for a new one, and fails or removes a member. Each
 * call returns as soon as mdadm has handed the work to the kernel. A reshape,
 * recovery, or resync then runs in the background, and the caller waits for
 * it with waitForSync. The caller checks the array is in a state where the
 * change is safe first; this only carries out the plan.
 */

import { MD_CHUNK_BYTES } from '@ohr/shared/constants';
import { type MdDetail, parseMdadmDetail } from '@ohr/shared/parsers/mdadm-detail';

import { type CommandRunner, runChecked } from '../command-runner.ts';

const BYTES_PER_KIB = 1024;
const DEVICE_PATH = /^\/dev\/\S+$/u;
/** Starting a reshape writes every member's superblock, which can be slow on sleeping drives. */
const MDADM_TIMEOUT_MS = 120_000;
/** mdadm's words for every member in that state, used when the member has no device node left. */
const MEMBER_KEYWORDS = ['failed', 'detached'] as const;

function assertDevicePath(path: string, what: string): void {
  if (!DEVICE_PATH.test(path)) {
    throw new RangeError(`${what} must be a device path, got "${path}"`);
  }
}

function assertMembers(members: readonly string[]): void {
  if (members.length === 0) {
    throw new RangeError('Name at least one member partition');
  }
  for (const member of members) {
    assertDevicePath(member, 'A member');
  }
}

/** Runs one mdadm change on the array and reports the array afterwards. */
async function mdadm(
  run: CommandRunner,
  array: string,
  args: readonly string[],
): Promise<MdDetail> {
  await runChecked(run, 'mdadm', args, { timeoutMs: MDADM_TIMEOUT_MS });
  return readArrayDetail(run, array);
}

/** A member by its device path, or every member mdadm sees as failed or whose device is gone. */
export type MemberRef = string | (typeof MEMBER_KEYWORDS)[number];

export interface ReplaceMemberRequest {
  /** The array's device path, such as /dev/md/ohr_p1_t1. */
  readonly array: string;
  /** The member partition to copy from. It stays in the array, marked faulty, once the copy is done. */
  readonly oldMember: string;
  /** The partition to copy to. It must already be in the array as a spare. */
  readonly newMember: string;
}

/**
 * What mdadm reports about an array now. Do not use it to tell a failed
 * member: mdadm 4.4 exports a failed member under its old slot number, and
 * a member taken out by --replace as a spare. /proc/mdstat marks both (F).
 */
export async function readArrayDetail(run: CommandRunner, array: string): Promise<MdDetail> {
  assertDevicePath(array, 'The array');
  return parseMdadmDetail(await runChecked(run, 'mdadm', ['--detail', '--export', array]));
}

/**
 * Adds partitions to the array. On a healthy array they become spares; on a
 * degraded one the kernel starts rebuilding onto them.
 */
export function mdadmAddArgs(array: string, members: readonly string[]): string[] {
  assertDevicePath(array, 'The array');
  assertMembers(members);
  return ['--manage', array, '--add', ...members];
}

/**
 * Grows the array to `raidDevices` active members, taking them from its
 * spares, and starts the reshape. No backup file: mdadm keeps the critical
 * section in the members' spare space (decision 0011).
 */
export function mdadmGrowDevicesArgs(array: string, raidDevices: number): string[] {
  assertDevicePath(array, 'The array');
  if (!Number.isSafeInteger(raidDevices) || raidDevices < 2) {
    throw new RangeError(`An array needs at least 2 members, got ${raidDevices}`);
  }
  return ['--grow', array, `--raid-devices=${raidDevices}`];
}

/**
 * Converts a two-member RAID1 to a two-member RAID5 in place. The layout on
 * disk is the same, so nothing is rewritten, but the chunk is mdadm's 64 KiB
 * default until mdadmChunkArgs runs after the array has grown.
 */
export function mdadmConvertToRaid5Args(array: string): string[] {
  assertDevicePath(array, 'The array');
  return ['--grow', array, '--level=5'];
}

/**
 * Sets the 512 KiB chunk from decision 0004, starting a reshape. mdadm
 * refuses this in the same command as a level change. Only run it once a
 * converted array has three or more members: on two members under writes
 * it deadlocks the kernel (decision 0011).
 */
export function mdadmChunkArgs(array: string): string[] {
  assertDevicePath(array, 'The array');
  return ['--grow', array, `--chunk=${MD_CHUNK_BYTES / BYTES_PER_KIB}`];
}

/**
 * Copies one member onto a spare while the old one stays in the array, so
 * the array keeps its redundancy throughout.
 */
export function mdadmReplaceArgs(request: ReplaceMemberRequest): string[] {
  const { array, oldMember, newMember } = request;
  assertDevicePath(array, 'The array');
  assertDevicePath(oldMember, 'The old member');
  assertDevicePath(newMember, 'The new member');
  if (oldMember === newMember) {
    throw new RangeError(`A member cannot replace itself: ${oldMember}`);
  }
  return ['--manage', array, '--replace', oldMember, '--with', newMember];
}

/** Marks a member faulty. The array runs degraded until it is replaced. */
export function mdadmFailArgs(array: string, member: string): string[] {
  assertDevicePath(array, 'The array');
  assertDevicePath(member, 'The member');
  return ['--manage', array, '--fail', member];
}

/** Takes a failed or spare member out of the array. mdadm refuses to remove an active one. */
export function mdadmRemoveArgs(array: string, member: MemberRef): string[] {
  assertDevicePath(array, 'The array');
  if (!MEMBER_KEYWORDS.some((keyword) => keyword === member)) {
    assertDevicePath(member, 'The member');
  }
  return ['--manage', array, '--remove', member];
}

export function addMembers(
  run: CommandRunner,
  request: { readonly array: string; readonly members: readonly string[] },
): Promise<MdDetail> {
  return mdadm(run, request.array, mdadmAddArgs(request.array, request.members));
}

export function growDevices(
  run: CommandRunner,
  request: { readonly array: string; readonly raidDevices: number },
): Promise<MdDetail> {
  return mdadm(run, request.array, mdadmGrowDevicesArgs(request.array, request.raidDevices));
}

export function convertToRaid5(run: CommandRunner, array: string): Promise<MdDetail> {
  return mdadm(run, array, mdadmConvertToRaid5Args(array));
}

export function setChunk(run: CommandRunner, array: string): Promise<MdDetail> {
  return mdadm(run, array, mdadmChunkArgs(array));
}

export function replaceMember(
  run: CommandRunner,
  request: ReplaceMemberRequest,
): Promise<MdDetail> {
  return mdadm(run, request.array, mdadmReplaceArgs(request));
}

export function failMember(
  run: CommandRunner,
  request: { readonly array: string; readonly member: string },
): Promise<MdDetail> {
  return mdadm(run, request.array, mdadmFailArgs(request.array, request.member));
}

export function removeMember(
  run: CommandRunner,
  request: { readonly array: string; readonly member: MemberRef },
): Promise<MdDetail> {
  return mdadm(run, request.array, mdadmRemoveArgs(request.array, request.member));
}
