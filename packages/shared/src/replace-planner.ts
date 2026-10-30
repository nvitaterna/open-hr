/**
 * Plans replacing one drive of a pool with a new one (decision 0011). The
 * new drive takes exactly the tiers the old one had; any room it has beyond
 * them is used by a following expand, so capacity does not change here.
 */

import {
  degradedTier,
  type ExpansionAction,
  type ExpansionError,
  type ExpansionResult,
  existingTarget,
  fits,
  labelPartition,
  minimumFor,
  newDriveError,
  type TargetTier,
  targetLayout,
  tierPartition,
  usableBefore,
} from './expansion-plan.ts';
import type { DriveInput } from './planner.ts';
import type { CurrentLayout, CurrentTier } from './pool-layout.ts';

interface OldDrive {
  /** Null when the drive is gone from the machine. */
  readonly id: string | null;
  /** The tiers it was in, always tier 1 up to some tier. */
  readonly tiers: readonly CurrentTier[];
}

/**
 * How one tier gets its new member: copied live while the old member stays
 * active there, or rebuilt where it failed or is gone. A drive can fail in
 * one tier and still work in another; that tier keeps its redundancy.
 */
function modeFor(tier: CurrentTier, oldId: string | null): 'live' | 'rebuild' {
  const member = tier.members.find((candidate) => candidate.drive === oldId);
  if (member?.state === 'active') {
    return 'live';
  }
  return 'rebuild';
}

/** The present drive to replace, or an error. */
function presentDrive(current: CurrentLayout, id: string): OldDrive | ExpansionError {
  if (!current.drives.some((drive) => drive.id === id)) {
    return { code: 'unknown-drive', driveId: id };
  }
  const degraded = degradedTier(current, id);
  if (degraded !== null) {
    return { code: 'pool-degraded', tier: degraded };
  }
  const tiers = current.tiers.filter((tier) => tier.members.some((member) => member.drive === id));
  return { id, tiers };
}

/** The one drive that is gone, from the slots its tiers are missing. */
function missingDrive(current: CurrentLayout): OldDrive | ExpansionError {
  const tiers = current.tiers.filter((tier) => tier.missingMembers > 0);
  if (tiers.length === 0) {
    return { code: 'no-missing-drive' };
  }
  // One missing drive leaves one empty slot in each of tiers 1 to k and nothing else wrong.
  const broken = current.tiers.find(
    (tier, index) =>
      tier.missingMembers > 1 ||
      (tier.missingMembers === 0 && index < tiers.length) ||
      tier.members.some((member) => member.state !== 'active'),
  );
  if (broken !== undefined) {
    return { code: 'pool-degraded', tier: broken.tier };
  }
  return { id: null, tiers };
}

function isError(value: OldDrive | ExpansionError): value is ExpansionError {
  return 'code' in value;
}

export function planReplacement(
  current: CurrentLayout,
  oldId: string | null,
  newDrive: DriveInput,
): ExpansionResult {
  let old = missingDrive(current);
  if (oldId !== null) {
    old = presentDrive(current, oldId);
  }
  if (isError(old)) {
    return { ok: false, error: old };
  }
  const invalid = newDriveError(current, [newDrive]);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  const top = old.tiers.at(-1);
  if (top !== undefined && !fits(newDrive.sizeBytes, top.offsetBytes + top.sliceBytes)) {
    const minimumBytes = minimumFor(top.offsetBytes + top.sliceBytes);
    return {
      ok: false,
      error: { code: 'replacement-too-small', driveId: newDrive.id, minimumBytes },
    };
  }
  const tiers: TargetTier[] = current.tiers.map((tier) => {
    const members = tier.members.map((member) => member.drive).filter((drive) => drive !== old.id);
    if (old.tiers.includes(tier)) {
      members.push(newDrive.id);
    }
    return existingTarget(tier, tier.level, members);
  });
  const actions: ExpansionAction[] = [
    {
      kind: 'partition-drive',
      drive: newDrive.id,
      partitions: [labelPartition(), ...tiers.slice(0, old.tiers.length).map(tierPartition)],
    },
    ...old.tiers.map(
      (tier): ExpansionAction => ({
        kind: 'replace-member',
        tier: tier.tier,
        oldDrive: old.id,
        newDrive: newDrive.id,
        mode: modeFor(tier, old.id),
      }),
    ),
  ];
  const drives = [
    ...current.drives
      .filter((drive) => drive.id !== old.id)
      .map((drive) => ({ id: drive.id, sizeBytes: drive.sizeBytes })),
    newDrive,
  ];
  return {
    ok: true,
    plan: {
      kind: 'replace',
      target: targetLayout(current.redundancy, drives, tiers),
      usableBytesBefore: usableBefore(current),
      actions,
    },
  };
}
