/** Helpers for the expansion planner tests. Not part of the package API. */

import { dataMembers, type RaidLevel } from './array-capacity.ts';
import { MD_CHUNK_BYTES, type Redundancy } from './constants.ts';
import type { ExpansionPlan, ExpansionResult } from './expansion-plan.ts';
import { describeExpansionError } from './expansion-planner.ts';
import { type Layout, planPool } from './planner.ts';
import { drives, layoutOf, MIB } from './planner-test-helpers.ts';
import type { CurrentLayout, CurrentTier } from './pool-layout.ts';
import { TIER_AREA_OFFSET_BYTES } from './tier-rules.ts';

/** Where pvcreate puts the first extent on a new array (decision 0004). */
export function freshFirstExtent(level: RaidLevel, members: number): number {
  if (level === 'raid1') {
    return MIB;
  }
  const stripe = dataMembers(level, members) * MD_CHUNK_BYTES;
  return Math.ceil(MIB / stripe) * stripe;
}

/**
 * The layout as the machine would report it once `layout` is built. Tiers
 * that were in `previous` keep their first extent, as pvresize does.
 */
export function asCurrent(layout: Layout, previous?: CurrentLayout): CurrentLayout {
  const tiers = layout.tiers.map((tier): CurrentTier => {
    const partition = layout.drives
      .find((drive) => drive.id === tier.members[0])
      ?.partitions.find((candidate) => candidate.tier === tier.tier);
    const before = previous?.tiers.find((candidate) => candidate.tier === tier.tier);
    return {
      tier: tier.tier,
      partitionNumber: tier.partitionNumber,
      level: tier.level,
      offsetBytes: (partition?.startBytes ?? 0) - TIER_AREA_OFFSET_BYTES,
      sliceBytes: tier.sliceBytes,
      members: tier.members.map((drive) => ({ drive, state: 'active' })),
      missingMembers: 0,
      arrayBytes: tier.arrayBytes,
      firstExtentBytes:
        before?.firstExtentBytes ?? freshFirstExtent(tier.level, tier.members.length),
    };
  });
  return {
    poolId: 'tank',
    redundancy: layout.redundancy,
    drives: layout.drives.map((drive) => ({
      id: drive.id,
      sizeBytes: drive.sizeBytes,
      partitions: drive.partitions.map((partition) => ({ ...partition })),
    })),
    tiers,
  };
}

/** A pool built from drives of these sizes in TB, named d0, d1, and so on. */
export function poolOf(sizesTb: readonly number[], redundancy: Redundancy = 'shr1'): CurrentLayout {
  return asCurrent(layoutOf(planPool(drives(sizesTb), redundancy)));
}

export function planOf(result: ExpansionResult): ExpansionPlan {
  if (!result.ok) {
    throw new Error(`Expected a plan, got: ${describeExpansionError(result.error)}`);
  }
  return result.plan;
}

/** The pool with one drive's members changed, such as marked faulty or gone, in every tier or one. */
export function withMember(
  current: CurrentLayout,
  drive: string,
  state: 'faulty' | 'gone',
  onlyTier: number | null = null,
): CurrentLayout {
  return {
    ...current,
    drives: current.drives.filter((candidate) => state !== 'gone' || candidate.id !== drive),
    tiers: current.tiers.map((tier) => {
      if (
        !tier.members.some((member) => member.drive === drive) ||
        (onlyTier !== null && tier.tier !== onlyTier)
      ) {
        return tier;
      }
      if (state === 'gone') {
        return {
          ...tier,
          members: tier.members.filter((member) => member.drive !== drive),
          missingMembers: tier.missingMembers + 1,
        };
      }
      return {
        ...tier,
        members: tier.members.map((member) => {
          if (member.drive !== drive) {
            return member;
          }
          return { ...member, state: 'faulty' as const };
        }),
      };
    }),
  };
}
