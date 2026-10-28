/**
 * Project-wide constants. These record decisions from docs/PLAN.md, so a
 * change here is a change to the plan and needs a decision record.
 */

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const ALIGNMENT_MIB = 1;
const END_RESERVE_MIB = 64;
const LABEL_PARTITION_MIB = 16;
const MIN_TIER_GIB = 1;

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

/** Partition alignment in bytes. */
export const PARTITION_ALIGNMENT_BYTES = ALIGNMENT_MIB * BYTES_PER_MIB;

/** Unused space kept at the end of every drive so a slightly smaller replacement still fits. */
export const END_OF_DRIVE_RESERVE_BYTES = END_RESERVE_MIB * BYTES_PER_MIB;

/** Size of the per-drive label partition that holds the Open HR descriptor. */
export const LABEL_PARTITION_BYTES = LABEL_PARTITION_MIB * BYTES_PER_MIB;

/** Where the first partition starts. The GPT header and table live before it. */
export const FIRST_PARTITION_OFFSET_BYTES = PARTITION_ALIGNMENT_BYTES;

/**
 * Smallest tier worth building an array for. Drives whose usable sizes differ
 * by less than this are treated as the same size, so two "4 TB" drives from
 * different vendors do not create a tiny extra tier.
 */
export const MIN_TIER_BYTES = MIN_TIER_GIB * BYTES_PER_KIB * BYTES_PER_MIB;
