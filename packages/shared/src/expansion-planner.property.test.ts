import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MIN_DRIVES, MIN_TIER_BYTES, type Redundancy } from './constants.ts';
import type { ExpansionPlan, ExpansionResult } from './expansion-plan.ts';
import { planExpansion } from './expansion-planner.ts';
import { asCurrent } from './expansion-test-helpers.ts';
import { planPool } from './planner.ts';
import { GIB, idealUsable, layoutOf } from './planner-test-helpers.ts';
import type { CurrentLayout } from './pool-layout.ts';
import { TIER_AREA_OFFSET_BYTES, tierAreaLimit } from './tier-rules.ts';

const MAX_DRIVES = 8;
const MAX_NEW = 3;
const MIN_GIB = 2;
const MAX_GIB = 20_000;
/** Errors a valid pool and valid new drives can still get. */
const EXPECTED_ERRORS: ReadonlySet<string> = new Set([
  'drive-too-small',
  'needs-raid6-conversion',
  'nothing-to-do',
]);

const sizeArb = fc.integer({ min: MIN_GIB, max: MAX_GIB }).map((gib) => gib * GIB);

const caseArb = fc.constantFrom<Redundancy>('shr1', 'shr2').chain((redundancy) =>
  fc.record({
    redundancy: fc.constant(redundancy),
    pool: fc.array(sizeArb, { minLength: MIN_DRIVES[redundancy], maxLength: MAX_DRIVES }),
    added: fc.array(sizeArb, { maxLength: MAX_NEW }),
  }),
);

function build(pool: readonly number[], redundancy: Redundancy): CurrentLayout {
  const input = pool.map((sizeBytes, index) => ({ id: `d${index}`, sizeBytes }));
  return asCurrent(layoutOf(planPool(input, redundancy)));
}

function keptPartitions(current: CurrentLayout, plan: ExpansionPlan): string[] {
  return current.drives.flatMap((drive) => {
    const after = plan.target.drives.find((candidate) => candidate.id === drive.id);
    const kept = after?.partitions.slice(0, drive.partitions.length);
    if (JSON.stringify(kept) === JSON.stringify(drive.partitions)) {
      return [];
    }
    return [`${drive.id} lost or changed a partition`];
  });
}

function fitting(plan: ExpansionPlan): string[] {
  return plan.target.drives.flatMap((drive) => {
    const found: string[] = [];
    let end = 0;
    for (const partition of drive.partitions) {
      if (partition.startBytes < end) {
        found.push(`${drive.id} partition ${partition.number} overlaps`);
      }
      end = partition.startBytes + partition.sizeBytes;
    }
    if (end > TIER_AREA_OFFSET_BYTES + tierAreaLimit(drive.sizeBytes)) {
      found.push(`${drive.id} runs past the end of the drive`);
    }
    return found;
  });
}

function capacity(current: CurrentLayout, plan: ExpansionPlan, sizes: readonly number[]): string[] {
  const checks: [boolean, string][] = [
    [
      plan.target.tiers
        .slice(current.tiers.length)
        .some((tier) => tier.sliceBytes < MIN_TIER_BYTES),
      'a new tier is smaller than the minimum',
    ],
    [plan.target.usableBytes < plan.usableBytesBefore, 'capacity shrank'],
    [
      plan.target.usableBytes > idealUsable(sizes, plan.target.redundancy),
      'capacity exceeds total minus the largest drives',
    ],
  ];
  return checks.filter(([broken]) => broken).map(([, message]) => message);
}

/** Broken rules for a plan, or the error code when there is no plan. */
function outcome(
  current: CurrentLayout,
  result: ExpansionResult,
  sizes: readonly number[],
): string[] {
  if (!result.ok) {
    if (EXPECTED_ERRORS.has(result.error.code)) {
      return [];
    }
    return [`unexpected ${result.error.code}`];
  }
  return [
    ...keptPartitions(current, result.plan),
    ...fitting(result.plan),
    ...capacity(current, result.plan, sizes),
  ];
}

/** What expanding again says, or null when there was nothing to expand the first time. */
function secondExpand(current: CurrentLayout, result: ExpansionResult): ExpansionResult | null {
  if (!result.ok) {
    return null;
  }
  return planExpansion(asCurrent(result.plan.target, current), { kind: 'expand', newDrives: [] });
}

describe('planExpansion properties', () => {
  it('keeps every existing partition, never shrinks, and stays within the drives', () => {
    fc.assert(
      fc.property(caseArb, ({ redundancy, pool, added }) => {
        const current = build(pool, redundancy);
        const newDrives = added.map((sizeBytes, index) => ({ id: `n${index}`, sizeBytes }));
        const result = planExpansion(current, { kind: 'expand', newDrives });
        expect(outcome(current, result, [...pool, ...added])).toEqual([]);
      }),
    );
  });

  it('uses all the room in one go, so expanding again finds nothing to do', () => {
    fc.assert(
      fc.property(caseArb, ({ redundancy, pool, added }) => {
        const current = build(pool, redundancy);
        const newDrives = added.map((sizeBytes, index) => ({ id: `n${index}`, sizeBytes }));
        const result = planExpansion(current, { kind: 'expand', newDrives });
        const again = secondExpand(current, result) ?? {
          ok: false,
          error: { code: 'nothing-to-do' },
        };
        expect(again).toEqual({ ok: false, error: { code: 'nothing-to-do' } });
      }),
    );
  });

  it('replaces any healthy drive with one of the same size without changing capacity', () => {
    fc.assert(
      fc.property(caseArb, fc.nat(), ({ redundancy, pool }, pick) => {
        const current = build(pool, redundancy);
        const old = current.drives[pick % current.drives.length] ?? { id: 'd0', sizeBytes: 0 };
        const newDrive = { id: 'n0', sizeBytes: old.sizeBytes };
        const result = planExpansion(current, { kind: 'replace', oldDrive: old.id, newDrive });
        const change = result.ok && result.plan.target.usableBytes - result.plan.usableBytesBefore;
        expect(change).toBe(0);
      }),
    );
  });
});
