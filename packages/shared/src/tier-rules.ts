/**
 * The rules both planners share (decision 0003): where the tier area of a
 * drive begins and ends, which md level a tier gets for its member count,
 * and where tier boundaries fall.
 */

import type { RaidLevel } from './array-capacity.ts';
import {
  END_OF_DRIVE_RESERVE_BYTES,
  FIRST_PARTITION_OFFSET_BYTES,
  LABEL_PARTITION_BYTES,
  MIN_TIER_BYTES,
  PARTITION_ALIGNMENT_BYTES,
  type Redundancy,
} from './constants.ts';
import { alignDown } from './sizes.ts';

const RAID1_MIRRORS_SHR1 = 2;
const RAID1_MIRRORS_SHR2 = 3;
const RAID5_MIN_MEMBERS = 3;
const RAID6_MIN_MEMBERS = 4;

export const LABEL_PARTITION_NUMBER = 1;

/** Offset where tier partitions begin, after the GPT area and the label partition. */
export const TIER_AREA_OFFSET_BYTES = FIRST_PARTITION_OFFSET_BYTES + LABEL_PARTITION_BYTES;

/** Smallest drive the planner accepts. */
export const MINIMUM_DRIVE_BYTES =
  TIER_AREA_OFFSET_BYTES + MIN_TIER_BYTES + END_OF_DRIVE_RESERVE_BYTES;

/** Space on a drive available to tier partitions when planning, before the end reserve. */
export function tierCapacity(sizeBytes: number): number {
  const end = alignDown(sizeBytes - END_OF_DRIVE_RESERVE_BYTES, PARTITION_ALIGNMENT_BYTES);
  return end - TIER_AREA_OFFSET_BYTES;
}

/**
 * How far into its tier area a drive can hold partitions at all: up to 1 MiB
 * before its end, which leaves room for the backup GPT. Joining an existing
 * tier only needs this, so the end reserve absorbs a slightly smaller
 * replacement (decision 0011).
 */
export function tierAreaLimit(sizeBytes: number): number {
  const end = alignDown(sizeBytes, PARTITION_ALIGNMENT_BYTES) - PARTITION_ALIGNMENT_BYTES;
  return end - TIER_AREA_OFFSET_BYTES;
}

/** md level for a tier with `members` drives, or null if it cannot provide the redundancy. */
export function levelFor(redundancy: Redundancy, members: number): RaidLevel | null {
  if (redundancy === 'shr1') {
    if (members >= RAID5_MIN_MEMBERS) {
      return 'raid5';
    }
    if (members === RAID1_MIRRORS_SHR1) {
      return 'raid1';
    }
    return null;
  }
  if (members >= RAID6_MIN_MEMBERS) {
    return 'raid6';
  }
  if (members === RAID1_MIRRORS_SHR2) {
    return 'raid1';
  }
  return null;
}

/**
 * Tier boundaries, as offsets into each drive's tier area, above `floor`.
 * Each boundary is the capacity of some drive. Capacities closer than
 * MIN_TIER_BYTES to the previous boundary are merged into it.
 */
export function tierBoundaries(capacities: readonly number[], floor = 0): number[] {
  const sorted = [...new Set(capacities)].sort((a, b) => a - b);
  const boundaries: number[] = [];
  let previous = floor;
  for (const capacity of sorted) {
    if (capacity - previous >= MIN_TIER_BYTES) {
      boundaries.push(capacity);
      previous = capacity;
    }
  }
  return boundaries;
}
