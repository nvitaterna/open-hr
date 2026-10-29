/** Helpers shared by the planner's example tests and property tests. Not part of the package API. */

import type { RaidLevel } from './array-capacity.ts';
import {
  END_OF_DRIVE_RESERVE_BYTES,
  FAULT_TOLERANCE,
  FIRST_PARTITION_OFFSET_BYTES,
  LABEL_PARTITION_BYTES,
  MIN_TIER_BYTES,
  PARTITION_ALIGNMENT_BYTES,
  type Redundancy,
} from './constants.ts';
import {
  type DriveInput,
  describePlanError,
  type Layout,
  type PlannedDrive,
  type PlannedPartition,
  type PlanResult,
} from './planner.ts';
import { alignDown } from './sizes.ts';

const BINARY_STEP = 1024;
const MINIMUM_RAID1_MEMBERS: Readonly<Record<Redundancy, number>> = { shr1: 2, shr2: 3 };
const MINIMUM_MEMBERS: Readonly<Record<Exclude<RaidLevel, 'raid1'>, number>> = {
  raid5: 3,
  raid6: 4,
};
const ALLOWED_LEVELS: Readonly<Record<Redundancy, readonly RaidLevel[]>> = {
  shr1: ['raid1', 'raid5'],
  shr2: ['raid1', 'raid6'],
};

function minimumMembers(level: RaidLevel, redundancy: Redundancy): number {
  if (level === 'raid1') {
    return MINIMUM_RAID1_MEMBERS[redundancy];
  }
  return MINIMUM_MEMBERS[level];
}

function singlePartitionViolations(
  driveId: string,
  partition: PlannedPartition,
  previousEnd: number,
): string[] {
  const where = `${driveId} partition ${partition.number}`;
  const checks: [boolean, string][] = [
    [partition.startBytes % PARTITION_ALIGNMENT_BYTES !== 0, `${where} start is not aligned`],
    [partition.sizeBytes % PARTITION_ALIGNMENT_BYTES !== 0, `${where} size is not aligned`],
    [partition.sizeBytes <= 0, `${where} is empty`],
    [partition.startBytes < previousEnd, `${where} overlaps the previous partition`],
  ];
  return checks.filter(([broken]) => broken).map(([, message]) => message);
}

function driveViolations(drive: PlannedDrive): string[] {
  const sorted = [...drive.partitions].sort((a, b) => a.startBytes - b.startBytes);
  const violations: string[] = [];
  let previousEnd = 0;
  for (const partition of sorted) {
    violations.push(...singlePartitionViolations(drive.id, partition, previousEnd));
    previousEnd = partition.startBytes + partition.sizeBytes;
  }
  if (previousEnd > drive.sizeBytes - END_OF_DRIVE_RESERVE_BYTES) {
    violations.push(`${drive.id} partitions run into the end-of-drive reserve`);
  }
  if (drive.unusedBytes < 0) {
    violations.push(`${drive.id} has negative unused space`);
  }
  return violations;
}

function tierViolations(layout: Layout): string[] {
  const violations: string[] = [];
  if (layout.tiers.length === 0) {
    violations.push('layout has no tiers');
  }
  for (const tier of layout.tiers) {
    const where = `tier ${tier.tier}`;
    if (tier.sliceBytes < MIN_TIER_BYTES) {
      violations.push(`${where} is smaller than the minimum tier`);
    }
    if (!ALLOWED_LEVELS[layout.redundancy].includes(tier.level)) {
      violations.push(`${where} uses ${tier.level}, not allowed for ${layout.redundancy}`);
    }
    if (tier.members.length < minimumMembers(tier.level, layout.redundancy)) {
      violations.push(`${where} has too few members for ${tier.level}`);
    }
    for (const member of tier.members) {
      const drive = layout.drives.find((candidate) => candidate.id === member);
      const partition = drive?.partitions.find((candidate) => candidate.tier === tier.tier);
      if (partition?.number !== tier.partitionNumber || partition.sizeBytes !== tier.sliceBytes) {
        violations.push(`${where} partition on ${member} does not match the tier`);
      }
    }
  }
  return violations;
}

export const TB = 1_000_000_000_000;
export const MIB = BINARY_STEP * BINARY_STEP;
export const GIB = MIB * BINARY_STEP;

export function drives(sizesTb: readonly number[]): DriveInput[] {
  return sizesTb.map((size, index) => ({ id: `d${index}`, sizeBytes: size * TB }));
}

export function layoutOf(result: PlanResult): Layout {
  if (!result.ok) {
    throw new Error(`Expected a layout, got: ${describePlanError(result.error)}`);
  }
  return result.layout;
}

/** Independent re-statement of the space each drive offers to tiers. */
export function tierAreaCapacity(sizeBytes: number): number {
  const end = alignDown(sizeBytes - END_OF_DRIVE_RESERVE_BYTES, PARTITION_ALIGNMENT_BYTES);
  return end - FIRST_PARTITION_OFFSET_BYTES - LABEL_PARTITION_BYTES;
}

/** Ideal usable capacity: the total minus the largest one (SHR-1) or two (SHR-2). */
export function idealUsable(capacities: readonly number[], redundancy: Redundancy): number {
  const sorted = [...capacities].sort((a, b) => b - a);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const lost = sorted.slice(0, FAULT_TOLERANCE[redundancy]).reduce((sum, value) => sum + value, 0);
  return total - lost;
}

/** Every rule a layout must follow, as a list of broken rules. Empty means valid. */
export function layoutViolations(layout: Layout, input: readonly DriveInput[]): string[] {
  const sizes = input.map((drive) => drive.sizeBytes);
  const violations = [...layout.drives.flatMap(driveViolations), ...tierViolations(layout)];
  if (layout.usableBytes > idealUsable(sizes, layout.redundancy)) {
    violations.push('usable capacity exceeds total minus the largest drives');
  }
  return violations;
}
