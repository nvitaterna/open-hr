/**
 * Project-wide constants. These record decisions from docs/PLAN.md, so a
 * change here is a change to the plan and needs a decision record.
 */

export const PROJECT_NAME = 'Open Hybrid RAID';
export const SHORT_NAME = 'ohr';

/** Default port for the web UI. */
export const DEFAULT_WEB_PORT = 7700;

/** Volumes are mounted under this directory by default. */
export const DEFAULT_MOUNT_ROOT = '/mnt/ohr';

/** Unix socket the root daemon listens on. */
export const CORE_SOCKET_PATH = '/run/ohr/core.sock';

export type Redundancy = 'shr1' | 'shr2';

/** Number of drive failures each redundancy level survives. */
export const FAULT_TOLERANCE: Readonly<Record<Redundancy, number>> = {
  shr1: 1,
  shr2: 2,
};

/** Fewest drives a pool may be created with. Single-drive pools are refused. */
export const MIN_DRIVES: Readonly<Record<Redundancy, number>> = {
  shr1: 2,
  shr2: 4,
};

export type FilesystemType = 'btrfs' | 'ext4';
export const FILESYSTEMS: readonly FilesystemType[] = ['btrfs', 'ext4'];

const MIB = 1024 * 1024;

/** Partition alignment in bytes. */
export const PARTITION_ALIGNMENT_BYTES = 1 * MIB;

/** Unused space kept at the end of every drive so a slightly smaller replacement still fits. */
export const END_OF_DRIVE_RESERVE_BYTES = 64 * MIB;

/** Size of the per-drive label partition that holds the Open HR descriptor. */
export const LABEL_PARTITION_BYTES = 16 * MIB;
