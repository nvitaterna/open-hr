/**
 * The SHR layout planner. Pure: no I/O, no clock, no randomness. Given drive
 * sizes and a redundancy level it returns exactly how each drive is
 * partitioned, which md arrays are built from which partitions, and the
 * usable capacity. docs/PLAN.md section 3 explains the method.
 */

import { arrayBytesFor, type RaidLevel, volumeGroupBytesFor } from './array-capacity.ts';
import {
  FIRST_PARTITION_OFFSET_BYTES,
  LABEL_PARTITION_BYTES,
  MIN_DRIVES,
  MIN_TIER_BYTES,
  type Redundancy,
} from './constants.ts';
import {
  LABEL_PARTITION_NUMBER,
  levelFor,
  MINIMUM_DRIVE_BYTES,
  TIER_AREA_OFFSET_BYTES,
  tierBoundaries,
  tierCapacity,
} from './tier-rules.ts';

function validate(drives: readonly DriveInput[], redundancy: Redundancy): PlanError | null {
  const required = MIN_DRIVES[redundancy];
  if (drives.length < required) {
    return { code: 'too-few-drives', required, actual: drives.length };
  }
  const seen = new Set<string>();
  for (const drive of drives) {
    if (seen.has(drive.id)) {
      return { code: 'duplicate-drive', driveId: drive.id };
    }
    seen.add(drive.id);
    if (!Number.isSafeInteger(drive.sizeBytes) || drive.sizeBytes <= 0) {
      return { code: 'invalid-size', driveId: drive.id };
    }
    if (tierCapacity(drive.sizeBytes) < MIN_TIER_BYTES) {
      return { code: 'drive-too-small', driveId: drive.id, minimumBytes: MINIMUM_DRIVE_BYTES };
    }
  }
  return null;
}

function labelPartition(): PlannedPartition {
  return {
    number: LABEL_PARTITION_NUMBER,
    role: 'label',
    tier: null,
    startBytes: FIRST_PARTITION_OFFSET_BYTES,
    sizeBytes: LABEL_PARTITION_BYTES,
  };
}

/** Builds every redundant tier and appends each member's partition to `partitionsByDrive`. */
function buildTiers(
  drives: readonly DriveInput[],
  capacities: readonly number[],
  redundancy: Redundancy,
  partitionsByDrive: PlannedPartition[][],
): PlannedTier[] {
  const tiers: PlannedTier[] = [];
  let tierStart = 0;
  for (const boundary of tierBoundaries(capacities)) {
    const memberIndexes = capacities
      .map((capacity, index) => ({ capacity, index }))
      .filter(({ capacity }) => capacity >= boundary)
      .map(({ index }) => index);
    const level = levelFor(redundancy, memberIndexes.length);
    if (level === null) {
      // Later tiers have even fewer members, so none of them can be redundant either.
      break;
    }
    const tierNumber = tiers.length + 1;
    const partitionNumber = LABEL_PARTITION_NUMBER + tierNumber;
    const sliceBytes = boundary - tierStart;
    const arrayBytes = arrayBytesFor(level, memberIndexes.length, sliceBytes);
    for (const index of memberIndexes) {
      partitionsByDrive[index]?.push({
        number: partitionNumber,
        role: 'tier',
        tier: tierNumber,
        startBytes: TIER_AREA_OFFSET_BYTES + tierStart,
        sizeBytes: sliceBytes,
      });
    }
    tiers.push({
      tier: tierNumber,
      partitionNumber,
      level,
      members: memberIndexes.map((index) => drives[index]?.id ?? ''),
      sliceBytes,
      arrayBytes,
      usableBytes: volumeGroupBytesFor(level, memberIndexes.length, arrayBytes),
    });
    tierStart = boundary;
  }
  return tiers;
}

function buildDrive(
  drive: DriveInput,
  capacity: number,
  partitions: readonly PlannedPartition[],
): PlannedDrive {
  const tierBytes = partitions
    .filter((partition) => partition.role === 'tier')
    .reduce((sum, partition) => sum + partition.sizeBytes, 0);
  return {
    id: drive.id,
    sizeBytes: drive.sizeBytes,
    partitions,
    unusedBytes: capacity - tierBytes,
  };
}

export interface DriveInput {
  /** Any stable identifier, such as a device path or serial number. */
  readonly id: string;
  readonly sizeBytes: number;
}

export interface PlannedPartition {
  readonly number: number;
  readonly role: 'label' | 'tier';
  /** Tier number for tier partitions, null for the label partition. */
  readonly tier: number | null;
  readonly startBytes: number;
  readonly sizeBytes: number;
}

export interface PlannedDrive {
  readonly id: string;
  readonly sizeBytes: number;
  readonly partitions: readonly PlannedPartition[];
  /** Space on this drive that tiers could use but no tier does, because no other drive is as large. */
  readonly unusedBytes: number;
}

export interface PlannedTier {
  /** Tier number, starting at 1. */
  readonly tier: number;
  /** GPT partition number that holds this tier on every member drive. */
  readonly partitionNumber: number;
  readonly level: RaidLevel;
  /** Drive ids in input order. */
  readonly members: readonly string[];
  /** Size of the partition each member contributes. */
  readonly sliceBytes: number;
  /** Size of the md array, after mdadm's per-member data offset. */
  readonly arrayBytes: number;
  /** Space the tier adds to the volume group, after LVM's own overhead. */
  readonly usableBytes: number;
}

export interface Layout {
  readonly redundancy: Redundancy;
  readonly drives: readonly PlannedDrive[];
  readonly tiers: readonly PlannedTier[];
  readonly rawBytes: number;
  readonly usableBytes: number;
}

export type PlanError =
  | { readonly code: 'too-few-drives'; readonly required: number; readonly actual: number }
  | { readonly code: 'duplicate-drive'; readonly driveId: string }
  | { readonly code: 'invalid-size'; readonly driveId: string }
  | { readonly code: 'drive-too-small'; readonly driveId: string; readonly minimumBytes: number };

export type PlanResult =
  | { readonly ok: true; readonly layout: Layout }
  | { readonly ok: false; readonly error: PlanError };

/** Smallest drive the planner accepts. */
export function minimumDriveBytes(): number {
  return MINIMUM_DRIVE_BYTES;
}

/** Plans a new pool from scratch. */
export function planPool(drives: readonly DriveInput[], redundancy: Redundancy): PlanResult {
  const error = validate(drives, redundancy);
  if (error !== null) {
    return { ok: false, error };
  }
  const capacities = drives.map((drive) => tierCapacity(drive.sizeBytes));
  const partitionsByDrive = drives.map(() => [labelPartition()]);
  const tiers = buildTiers(drives, capacities, redundancy, partitionsByDrive);
  return {
    ok: true,
    layout: {
      redundancy,
      drives: drives.map((drive, index) =>
        buildDrive(drive, capacities[index] ?? 0, partitionsByDrive[index] ?? []),
      ),
      tiers,
      rawBytes: drives.reduce((sum, drive) => sum + drive.sizeBytes, 0),
      usableBytes: tiers.reduce((sum, tier) => sum + tier.usableBytes, 0),
    },
  };
}

/** One-line human description of a planning error. */
export function describePlanError(error: PlanError): string {
  switch (error.code) {
    case 'too-few-drives':
      return `This redundancy level needs at least ${error.required} drives, but ${error.actual} were given.`;
    case 'duplicate-drive':
      return `Drive "${error.driveId}" was given more than once.`;
    case 'invalid-size':
      return `Drive "${error.driveId}" has an invalid size.`;
    case 'drive-too-small':
      return `Drive "${error.driveId}" is too small. Each drive needs at least ${error.minimumBytes} bytes.`;
    default:
      throw new Error(`Unhandled plan error: ${String(error satisfies never)}`);
  }
}
