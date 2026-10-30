/**
 * Grows a mounted filesystem to fill its logical volume after the volume has
 * grown (decision 0011). Both filesystems Open HR makes grow online, so the
 * volume stays mounted and in use throughout. Running it again on a
 * filesystem that already fills its volume changes nothing.
 */

import type { FilesystemType } from '@ohr/shared/constants';

import { type CommandRunner, runChecked } from '../command-runner.ts';
import { assertMountPoint } from './mount.ts';

/** Growing ext4 online writes new group descriptors, which takes a while on a large volume. */
const GROW_TIMEOUT_MS = 600_000;

export interface GrowFilesystemRequest {
  /** Device path of the logical volume, already grown. */
  readonly device: string;
  readonly type: FilesystemType;
  /** Where the volume is mounted. btrfs grows only through its mount point. */
  readonly mountPoint: string;
}

/** The program and arguments that grow the filesystem to fill its volume. */
export function growFilesystemCommand(request: GrowFilesystemRequest): {
  readonly command: string;
  readonly args: string[];
} {
  assertMountPoint(request.mountPoint);
  switch (request.type) {
    case 'btrfs':
      return { command: 'btrfs', args: ['filesystem', 'resize', 'max', request.mountPoint] };
    case 'ext4':
      return { command: 'resize2fs', args: [request.device] };
    default:
      throw new Error(`Unhandled filesystem type: ${String(request.type satisfies never)}`);
  }
}

export async function growFilesystem(
  run: CommandRunner,
  request: GrowFilesystemRequest,
): Promise<void> {
  const { command, args } = growFilesystemCommand(request);
  await runChecked(run, command, args, { timeoutMs: GROW_TIMEOUT_MS });
}
