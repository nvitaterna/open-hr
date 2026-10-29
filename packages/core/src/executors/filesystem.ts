/**
 * Puts a filesystem on a volume (plan sections 4.3 and 4.8). A btrfs volume
 * gets a `@data` subvolume, which is what gets mounted, and a `.snapshots`
 * subvolume beside it for later snapshots. Destructive: it replaces whatever
 * the volume held. lvcreate wiped the volume, so mkfs runs without a force
 * flag and fails loudly if a filesystem is somehow still there.
 */

import { mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FILESYSTEMS, type FilesystemType } from '@ohr/shared/constants';
import { parseBlkid } from '@ohr/shared/parsers/blkid';
import { assertVolumeName } from '@ohr/shared/volume-name';

import { type CommandRunner, runChecked } from '../command-runner.ts';
import { singleRow } from './single-row.ts';

/** ext4 labels hold 16 bytes. Volume names are ASCII, so that is 16 characters. */
const EXT4_LABEL_MAX_CHARS = 16;
/** Formatting a large volume takes a while. */
const MKFS_TIMEOUT_MS = 600_000;
const MOUNT_TIMEOUT_MS = 60_000;

function isFilesystemType(value: string | null): value is FilesystemType {
  return FILESYSTEMS.some((type) => type === value);
}

/** Removes the scratch directory. If it is somehow still mounted, it stays for the user to see. */
async function removeScratchDir(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch {
    // Still mounted or not empty: leave it in place rather than hide the problem.
  }
}

/** Mounts the top level of a new btrfs filesystem in a scratch directory and creates both subvolumes. */
async function createBtrfsSubvolumes(run: CommandRunner, device: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ohr-btrfs-'));
  try {
    await runChecked(run, 'mount', ['-t', 'btrfs', device, dir], { timeoutMs: MOUNT_TIMEOUT_MS });
    try {
      await runChecked(run, 'btrfs', ['subvolume', 'create', join(dir, BTRFS_DATA_SUBVOLUME)]);
      await runChecked(run, 'btrfs', ['subvolume', 'create', join(dir, BTRFS_SNAPSHOTS_SUBVOLUME)]);
    } finally {
      await runChecked(run, 'umount', [dir], { timeoutMs: MOUNT_TIMEOUT_MS });
    }
  } finally {
    await removeScratchDir(dir);
  }
}

/** The btrfs subvolume that is mounted as the volume. */
export const BTRFS_DATA_SUBVOLUME = '@data';
/** The btrfs subvolume that will hold snapshots. */
export const BTRFS_SNAPSHOTS_SUBVOLUME = '.snapshots';

export interface MakeFilesystemRequest {
  /** Device path of the logical volume. */
  readonly device: string;
  readonly type: FilesystemType;
  /** Volume name. It becomes the filesystem label. */
  readonly name: string;
}

export interface Filesystem {
  readonly type: FilesystemType;
  readonly uuid: string;
  readonly label: string;
}

/** The label mkfs writes: the volume name, cut to what ext4 can hold. */
export function filesystemLabel(type: FilesystemType, name: string): string {
  assertVolumeName(name);
  if (type === 'ext4') {
    return name.slice(0, EXT4_LABEL_MAX_CHARS);
  }
  return name;
}

/** The mkfs program and its arguments for a volume. */
export function mkfsCommand(request: MakeFilesystemRequest): {
  readonly command: string;
  readonly args: string[];
} {
  const label = filesystemLabel(request.type, request.name);
  switch (request.type) {
    case 'btrfs':
      return { command: 'mkfs.btrfs', args: ['--quiet', '--label', label, request.device] };
    case 'ext4':
      return { command: 'mkfs.ext4', args: ['-q', '-L', label, request.device] };
    default:
      throw new Error(`Unhandled filesystem type: ${String(request.type satisfies never)}`);
  }
}

/** What blkid finds on a device. Throws unless it is one of the filesystems Open HR makes. */
export async function readFilesystem(run: CommandRunner, device: string): Promise<Filesystem> {
  const entry = singleRow(
    parseBlkid(await runChecked(run, 'blkid', ['-o', 'export', device])),
    'device',
  );
  if (!isFilesystemType(entry.type) || entry.uuid === null) {
    throw new Error(`${device} holds ${entry.type ?? 'no filesystem'}, not an Open HR filesystem`);
  }
  return { type: entry.type, uuid: entry.uuid, label: entry.label ?? '' };
}

/** Formats the volume, sets up btrfs subvolumes, and reports what blkid sees. */
export async function makeFilesystem(
  run: CommandRunner,
  request: MakeFilesystemRequest,
): Promise<Filesystem> {
  const { command, args } = mkfsCommand(request);
  await runChecked(run, command, args, { timeoutMs: MKFS_TIMEOUT_MS });
  if (request.type === 'btrfs') {
    await createBtrfsSubvolumes(run, request.device);
  }
  const filesystem = await readFilesystem(run, request.device);
  if (filesystem.type !== request.type) {
    throw new Error(`${request.device} holds ${filesystem.type} after making ${request.type}`);
  }
  return filesystem;
}
