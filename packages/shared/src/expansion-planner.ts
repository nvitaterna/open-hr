/**
 * Plans a change to an existing pool (decision 0011). Pure, like planPool.
 * Existing tiers never move: drives join tiers from the bottom up, as many
 * as they have room for, and new tiers go above the highest one.
 */

import type { RaidLevel } from './array-capacity.ts';
import {
  degradedTier,
  type ExpansionAction,
  type ExpansionChange,
  type ExpansionError,
  type ExpansionResult,
  existingTarget,
  fits,
  labelPartition,
  minimumFor,
  newDriveError,
  newTarget,
  type TargetTier,
  targetLayout,
  tierPartition,
  usableBefore,
} from './expansion-plan.ts';
import type { DriveInput } from './planner.ts';
import type { CurrentLayout, CurrentTier } from './pool-layout.ts';
import { planReplacement } from './replace-planner.ts';
import { levelFor, tierBoundaries, tierCapacity } from './tier-rules.ts';

interface Joined {
  readonly drive: DriveInput;
  readonly isNew: boolean;
  /** How many tiers, counted from tier 1, the drive is in before the change. */
  readonly before: number;
  /** And after it. */
  readonly after: number;
}

type Planned<T> = T | { readonly error: ExpansionError };

function failed<T>(value: Planned<T>): value is { readonly error: ExpansionError } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function tierEnd(tier: CurrentTier): number {
  return tier.offsetBytes + tier.sliceBytes;
}

/** Each drive's tiers before and after: it joins every next tier it has room for. */
function joinTiers(current: CurrentLayout, newDrives: readonly DriveInput[]): Planned<Joined[]> {
  const existing = current.drives.map((drive) => ({
    drive: { id: drive.id, sizeBytes: drive.sizeBytes },
    isNew: false,
    before: current.tiers.filter((tier) => tier.members.some((m) => m.drive === drive.id)).length,
  }));
  const added = newDrives.map((drive) => ({ drive, isNew: true, before: 0 }));
  const joined: Joined[] = [];
  for (const item of [...existing, ...added]) {
    let after = item.before;
    while (
      after < current.tiers.length &&
      fits(item.drive.sizeBytes, tierEnd(current.tiers[after] as CurrentTier))
    ) {
      after += 1;
    }
    const [first] = current.tiers;
    if (item.isNew && after === 0 && first !== undefined) {
      return {
        error: {
          code: 'drive-too-small',
          driveId: item.drive.id,
          minimumBytes: minimumFor(tierEnd(first)),
        },
      };
    }
    joined.push({ ...item, after });
  }
  return joined;
}

/** Existing tiers with their members after the change. */
function grownTiers(current: CurrentLayout, joined: readonly Joined[]): Planned<TargetTier[]> {
  const tiers: TargetTier[] = [];
  for (const [index, tier] of current.tiers.entries()) {
    const members = joined.filter((item) => item.after > index).map((item) => item.drive.id);
    let level: RaidLevel = tier.level;
    if (members.length > tier.members.length) {
      level = levelFor(current.redundancy, members.length) ?? tier.level;
      if (tier.level === 'raid1' && level === 'raid6') {
        return { error: { code: 'needs-raid6-conversion', tier: tier.tier } };
      }
    }
    tiers.push(existingTarget(tier, level, members));
  }
  return tiers;
}

/** New tiers above the highest one, from the space every top-tier drive has left. */
function newTiers(current: CurrentLayout, joined: readonly Joined[]): TargetTier[] {
  const top = current.tiers.reduce((end, tier) => Math.max(end, tierEnd(tier)), 0);
  const room = joined.map((item) => {
    if (item.after < current.tiers.length) {
      return 0;
    }
    return Math.max(0, tierCapacity(item.drive.sizeBytes) - top);
  });
  const tiers: TargetTier[] = [];
  let start = 0;
  for (const boundary of tierBoundaries(room.filter((space) => space > 0))) {
    const members = joined
      .filter((_, index) => (room[index] ?? 0) >= boundary)
      .map((item) => item.drive.id);
    const level = levelFor(current.redundancy, members.length);
    if (level === null) {
      break;
    }
    const number = current.tiers.length + tiers.length + 1;
    tiers.push(
      newTarget({
        tier: number,
        level,
        offsetBytes: top + start,
        sliceBytes: boundary - start,
        members,
      }),
    );
    start = boundary;
  }
  return tiers;
}

function partitionActions(
  joined: readonly Joined[],
  tiers: readonly TargetTier[],
): ExpansionAction[] {
  return joined.flatMap((item): ExpansionAction[] => {
    const added = tiers
      .filter((tier, index) => tier.members.includes(item.drive.id) && index >= item.before)
      .map(tierPartition);
    if (item.isNew) {
      return [
        { kind: 'partition-drive', drive: item.drive.id, partitions: [labelPartition(), ...added] },
      ];
    }
    if (added.length === 0) {
      return [];
    }
    return [{ kind: 'add-partitions', drive: item.drive.id, partitions: added }];
  });
}

/** Convert if needed, then add the new members and reshape. */
function growActions(tier: CurrentTier, target: TargetTier): ExpansionAction[] {
  const actions: ExpansionAction[] = [];
  if (tier.level === 'raid1' && target.level === 'raid5') {
    actions.push({ kind: 'convert-to-raid5', tier: tier.tier });
  }
  const existing = new Set(tier.members.map((member) => member.drive));
  actions.push({
    kind: 'grow-tier',
    tier: tier.tier,
    level: target.level,
    add: target.members.filter((drive) => !existing.has(drive)),
    members: target.members.length,
  });
  return actions;
}

function tierActions(
  current: CurrentLayout,
  grown: readonly TargetTier[],
  created: readonly TargetTier[],
): ExpansionAction[] {
  const growing = current.tiers.flatMap((tier, index) => {
    const target = grown[index];
    if (target === undefined || target.members.length === tier.members.length) {
      return [];
    }
    return [{ tier, target }];
  });
  return [
    ...growing.flatMap(({ tier, target }) => growActions(tier, target)),
    ...growing.map(
      ({ tier }): ExpansionAction => ({ kind: 'resize-physical-volume', tier: tier.tier }),
    ),
    ...created.map(
      (tier): ExpansionAction => ({
        kind: 'create-tier',
        tier: tier.tier,
        level: tier.level,
        members: tier.members,
      }),
    ),
  ];
}

function planExpand(current: CurrentLayout, newDrives: readonly DriveInput[]): ExpansionResult {
  const degraded = degradedTier(current);
  if (degraded !== null) {
    return { ok: false, error: { code: 'pool-degraded', tier: degraded } };
  }
  const invalid = newDriveError(current, newDrives);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  const joined = joinTiers(current, newDrives);
  if (failed(joined)) {
    return { ok: false, error: joined.error };
  }
  const grown = grownTiers(current, joined);
  if (failed(grown)) {
    return { ok: false, error: grown.error };
  }
  const created = newTiers(current, joined);
  const tiers = [...grown, ...created];
  const actions = [...partitionActions(joined, tiers), ...tierActions(current, grown, created)];
  if (actions.length === 0) {
    return { ok: false, error: { code: 'nothing-to-do' } };
  }
  const drives = joined.map((item) => item.drive);
  return {
    ok: true,
    plan: {
      kind: 'expand',
      target: targetLayout(current.redundancy, drives, tiers),
      usableBytesBefore: usableBefore(current),
      actions,
    },
  };
}

/** Plans adding drives, using leftover space, or replacing a drive. */
export function planExpansion(current: CurrentLayout, change: ExpansionChange): ExpansionResult {
  if (change.kind === 'replace') {
    return planReplacement(current, change.oldDrive, change.newDrive);
  }
  return planExpand(current, change.newDrives);
}

/** One-line human description of an expansion error. */
export function describeExpansionError(error: ExpansionError): string {
  switch (error.code) {
    case 'pool-degraded':
      return `Tier ${error.tier} is missing a drive or rebuilding. Replace or wait for it first.`;
    case 'duplicate-drive':
      return `Drive "${error.driveId}" was given more than once.`;
    case 'drive-in-pool':
      return `Drive "${error.driveId}" is already in the pool.`;
    case 'invalid-size':
      return `Drive "${error.driveId}" has an invalid size.`;
    case 'drive-too-small':
      return `Drive "${error.driveId}" is too small to join tier 1. It needs at least ${error.minimumBytes} bytes.`;
    case 'unknown-drive':
      return `Drive "${error.driveId}" is not in the pool.`;
    case 'no-missing-drive':
      return 'No drive of the pool is missing. Name the drive to replace.';
    case 'replacement-too-small':
      return `Drive "${error.driveId}" is too small to take the old drive's place. It needs at least ${error.minimumBytes} bytes.`;
    case 'needs-raid6-conversion':
      return `Tier ${error.tier} would have to change from RAID1 to RAID6, which Open HR cannot do yet.`;
    case 'nothing-to-do':
      return 'Nothing would change: there are no new drives and no leftover space to use.';
    default:
      throw new Error(`Unhandled expansion error: ${String(error satisfies never)}`);
  }
}
