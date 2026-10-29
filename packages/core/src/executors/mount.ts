/**
 * Mounts and unmounts volumes (plan section 4.3). A btrfs volume is mounted
 * at its `@data` subvolume. Mount points default to /mnt/ohr/<volume>. The
 * systemd mount units that make a mount survive a reboot come separately.
 */

import { mkdir } from 'node:fs/promises';
import { posix } from 'node:path';

import { DEFAULT_MOUNT_ROOT, type FilesystemType } from '@ohr/shared/constants';
import { FINDMNT_COLUMNS, type Mount, parseFindmnt } from '@ohr/shared/parsers/findmnt';
import { assertVolumeName } from '@ohr/shared/volume-name';

import { type CommandRunner, runChecked } from '../command-runner.ts';
import { BTRFS_DATA_SUBVOLUME } from './filesystem.ts';
import { singleRow } from './single-row.ts';

const MOUNT_TIMEOUT_MS = 60_000;
const ROOT = '/';

function assertMountPoint(path: string): void {
  if (
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path === ROOT ||
    path.endsWith(ROOT)
  ) {
    throw new RangeError(`Mount point must be a normalized absolute directory path, got "${path}"`);
  }
}

export interface MountRequest {
  /** Device path of the logical volume. */
  readonly device: string;
  readonly type: FilesystemType;
  readonly mountPoint: string;
}

/** Where a volume is mounted unless the user chooses otherwise. */
export function defaultMountPoint(name: string): string {
  assertVolumeName(name);
  return `${DEFAULT_MOUNT_ROOT}/${name}`;
}

/** Mount options per filesystem type. btrfs mounts the data subvolume. */
export function mountOptions(type: FilesystemType): string[] {
  if (type === 'btrfs') {
    return [`subvol=${BTRFS_DATA_SUBVOLUME}`];
  }
  return [];
}

export function mountArgs(request: MountRequest): string[] {
  assertMountPoint(request.mountPoint);
  const args = ['-t', request.type];
  const options = mountOptions(request.type);
  if (options.length > 0) {
    args.push('-o', options.join(','));
  }
  args.push(request.device, request.mountPoint);
  return args;
}

/** What findmnt reports for the mount at `mountPoint`. Throws if nothing is mounted there. */
export async function readMount(run: CommandRunner, mountPoint: string): Promise<Mount> {
  const report = await runChecked(run, 'findmnt', [
    '--json',
    '--bytes',
    '--output',
    FINDMNT_COLUMNS.join(','),
    mountPoint,
  ]);
  return singleRow(parseFindmnt(report), 'mount');
}

/** Creates the mount point if needed, mounts the volume, and reports what findmnt sees. */
export async function mountVolume(run: CommandRunner, request: MountRequest): Promise<Mount> {
  const args = mountArgs(request);
  await mkdir(request.mountPoint, { recursive: true });
  await runChecked(run, 'mount', args, { timeoutMs: MOUNT_TIMEOUT_MS });
  return readMount(run, request.mountPoint);
}

export async function unmountVolume(run: CommandRunner, mountPoint: string): Promise<void> {
  assertMountPoint(mountPoint);
  await runChecked(run, 'umount', [mountPoint], { timeoutMs: MOUNT_TIMEOUT_MS });
}
