/**
 * Types and helpers shared by the expand and replace planners (decision
 * 0011): the change a user asks for, the plan that comes back, and how a
 * target layout is put together from tiers and drives.
 */

import { arrayBytesFor, type RaidLevel, volumeGroupBytesFor } from './array-capacity.ts';
import {
  FIRST_PARTITION_OFFSET_BYTES,
  LABEL_PARTITION_BYTES,
  LVM_EXTENT_BYTES,
  type Redundancy,
} from './constants.ts';
import type { DriveInput, Layout, PlannedDrive, PlannedPartition, PlannedTier } from './planner.ts';
import type { CurrentLayout, CurrentTier } from './pool-layout.ts';
import { alignDown } from './sizes.ts';
import {
  LABEL_PARTITION_NUMBER,
  TIER_AREA_OFFSET_BYTES,
  tierAreaLimit,
  tierCapacity,
} from './tier-rules.ts';

export type ExpansionChange =
  /** Add these drives, if any, and use every drive's leftover space. */
  | { readonly kind: 'expand'; readonly newDrives: readonly DriveInput[] }
  /** Put `newDrive` in place of `oldDrive`, or of the one missing drive when `oldDrive` is null. */
  | { readonly kind: 'replace'; readonly oldDrive: string | null; readonly newDrive: DriveInput };

export type ExpansionAction =
  /** A drive new to the pool: label partition and tier partitions. */
  | {
      readonly kind: 'partition-drive';
      readonly drive: string;
      readonly partitions: readonly PlannedPartition[];
    }
  /** New tier partitions on a drive already in the pool. */
  | {
      readonly kind: 'add-partitions';
      readonly drive: string;
      readonly partitions: readonly PlannedPartition[];
    }
  /** A two-member RAID1 tier becomes a two-member RAID5 with the 512 KiB chunk. */
  | { readonly kind: 'convert-to-raid5'; readonly tier: number }
  /** Add these drives' partitions to the tier's array and reshape it to `members`. */
  | {
      readonly kind: 'grow-tier';
      readonly tier: number;
      readonly level: RaidLevel;
      readonly add: readonly string[];
      readonly members: number;
    }
  | { readonly kind: 'resize-physical-volume'; readonly tier: number }
  | {
      readonly kind: 'create-tier';
      readonly tier: number;
      readonly level: RaidLevel;
      readonly members: readonly string[];
    }
  /**
   * `live` copies onto the new partition while the old one stays in the
   * array; `rebuild` removes a failed or missing member and rebuilds.
   */
  | {
      readonly kind: 'replace-member';
      readonly tier: number;
      readonly oldDrive: string | null;
      readonly newDrive: string;
      readonly mode: 'live' | 'rebuild';
    };

export interface ExpansionPlan {
  readonly kind: ExpansionChange['kind'];
  /** The pool after the change. Its usableBytes is the capacity afterwards. */
  readonly target: Layout;
  readonly usableBytesBefore: number;
  /** In the order a job carries them out. */
  readonly actions: readonly ExpansionAction[];
}

export type ExpansionError =
  | { readonly code: 'pool-degraded'; readonly tier: number }
  | { readonly code: 'duplicate-drive'; readonly driveId: string }
  | { readonly code: 'drive-in-pool'; readonly driveId: string }
  | { readonly code: 'invalid-size'; readonly driveId: string }
  | { readonly code: 'drive-too-small'; readonly driveId: string; readonly minimumBytes: number }
  | { readonly code: 'unknown-drive'; readonly driveId: string }
  | { readonly code: 'no-missing-drive' }
  | {
      readonly code: 'replacement-too-small';
      readonly driveId: string;
      readonly minimumBytes: number;
    }
  | { readonly code: 'needs-raid6-conversion'; readonly tier: number }
  | { readonly code: 'nothing-to-do' };

export type ExpansionResult =
  | { readonly ok: true; readonly plan: ExpansionPlan }
  | { readonly ok: false; readonly error: ExpansionError };

/** A tier of the target layout, existing or new. */
export interface TargetTier {
  readonly tier: number;
  readonly level: RaidLevel;
  readonly offsetBytes: number;
  readonly sliceBytes: number;
  readonly members: readonly string[];
  readonly arrayBytes: number;
  readonly usableBytes: number;
}

/** Space an existing array gives LVM, from where its first extent really starts. */
export function usableOf(arrayBytes: number, firstExtentBytes: number): number {
  return alignDown(arrayBytes - firstExtentBytes, LVM_EXTENT_BYTES);
}

/** An existing tier with `members`. Its first extent stays where it is when it grows. */
export function existingTarget(
  tier: CurrentTier,
  level: RaidLevel,
  members: readonly string[],
): TargetTier {
  let { arrayBytes } = tier;
  if (level !== tier.level || members.length !== tier.members.length + tier.missingMembers) {
    arrayBytes = arrayBytesFor(level, members.length, tier.sliceBytes);
  }
  return {
    tier: tier.tier,
    level,
    offsetBytes: tier.offsetBytes,
    sliceBytes: tier.sliceBytes,
    members,
    arrayBytes,
    usableBytes: usableOf(arrayBytes, tier.firstExtentBytes),
  };
}

/** A tier that does not exist yet, sized like one in a new pool. */
export function newTarget(tier: Omit<TargetTier, 'arrayBytes' | 'usableBytes'>): TargetTier {
  const arrayBytes = arrayBytesFor(tier.level, tier.members.length, tier.sliceBytes);
  return {
    ...tier,
    arrayBytes,
    usableBytes: volumeGroupBytesFor(tier.level, tier.members.length, arrayBytes),
  };
}

/** True when the drive has room for a tier ending at `endBytes` of the tier area. */
export function fits(sizeBytes: number, endBytes: number): boolean {
  return endBytes <= tierAreaLimit(sizeBytes);
}

/** Smallest drive that has room for a tier ending at `endBytes`. */
export function minimumFor(endBytes: number): number {
  return TIER_AREA_OFFSET_BYTES + endBytes + FIRST_PARTITION_OFFSET_BYTES;
}

export function tierPartition(tier: TargetTier): PlannedPartition {
  return {
    number: LABEL_PARTITION_NUMBER + tier.tier,
    role: 'tier',
    tier: tier.tier,
    startBytes: TIER_AREA_OFFSET_BYTES + tier.offsetBytes,
    sizeBytes: tier.sliceBytes,
  };
}

export function labelPartition(): PlannedPartition {
  return {
    number: LABEL_PARTITION_NUMBER,
    role: 'label',
    tier: null,
    startBytes: FIRST_PARTITION_OFFSET_BYTES,
    sizeBytes: LABEL_PARTITION_BYTES,
  };
}

/** The whole pool after the change, in the planner's Layout shape so the UI can draw it. */
export function targetLayout(
  redundancy: Redundancy,
  drives: readonly DriveInput[],
  tiers: readonly TargetTier[],
): Layout {
  const planned = drives.map((drive): PlannedDrive => {
    const own = tiers.filter((tier) => tier.members.includes(drive.id));
    const used = own.reduce((sum, tier) => sum + tier.sliceBytes, 0);
    return {
      id: drive.id,
      sizeBytes: drive.sizeBytes,
      partitions: [labelPartition(), ...own.map(tierPartition)],
      unusedBytes: Math.max(0, tierCapacity(drive.sizeBytes) - used),
    };
  });
  const plannedTiers = tiers.map(
    (tier): PlannedTier => ({
      tier: tier.tier,
      partitionNumber: LABEL_PARTITION_NUMBER + tier.tier,
      level: tier.level,
      members: drives.filter((drive) => tier.members.includes(drive.id)).map((drive) => drive.id),
      sliceBytes: tier.sliceBytes,
      arrayBytes: tier.arrayBytes,
      usableBytes: tier.usableBytes,
    }),
  );
  return {
    redundancy,
    drives: planned,
    tiers: plannedTiers,
    rawBytes: drives.reduce((sum, drive) => sum + drive.sizeBytes, 0),
    usableBytes: tiers.reduce((sum, tier) => sum + tier.usableBytes, 0),
  };
}

export function usableBefore(current: CurrentLayout): number {
  return current.tiers.reduce(
    (sum, tier) => sum + usableOf(tier.arrayBytes, tier.firstExtentBytes),
    0,
  );
}

/** The first tier with a slot no healthy member fills, or null. */
export function degradedTier(current: CurrentLayout, ignore: string | null = null): number | null {
  const tier = current.tiers.find(
    (candidate) =>
      candidate.missingMembers > 0 ||
      candidate.members.some((member) => member.state !== 'active' && member.drive !== ignore),
  );
  return tier?.tier ?? null;
}

/** An error for the first new drive that cannot be added at all. */
export function newDriveError(
  current: CurrentLayout,
  drives: readonly DriveInput[],
): ExpansionError | null {
  const seen = new Set(current.drives.map((drive) => drive.id));
  for (const drive of drives) {
    if (current.drives.some((existing) => existing.id === drive.id)) {
      return { code: 'drive-in-pool', driveId: drive.id };
    }
    if (seen.has(drive.id)) {
      return { code: 'duplicate-drive', driveId: drive.id };
    }
    seen.add(drive.id);
    if (!Number.isSafeInteger(drive.sizeBytes) || drive.sizeBytes <= 0) {
      return { code: 'invalid-size', driveId: drive.id };
    }
  }
  return null;
}
