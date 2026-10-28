import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MIN_DRIVES, MIN_TIER_BYTES, type Redundancy } from './constants.ts';
import { minimumDriveBytes, planPool } from './planner.ts';
import {
  GIB,
  idealUsable,
  layoutOf,
  layoutViolations,
  TB,
  tierAreaCapacity,
} from './planner-test-helpers.ts';

const MAX_DRIVES = 12;
const MIN_DRIVE_GIB = 2;
const MAX_DRIVE_GIB = 30_000;
const MAX_DRIVE_TB = 30;

const redundancyArb = fc.constantFrom<Redundancy>('shr1', 'shr2');

function drivesArb(sizeArb: fc.Arbitrary<number>, unitBytes: number) {
  return redundancyArb.chain((redundancy) =>
    fc
      .array(sizeArb, { minLength: MIN_DRIVES[redundancy], maxLength: MAX_DRIVES })
      .map((sizes) => ({
        redundancy,
        drives: sizes.map((size, index) => ({ id: `d${index}`, sizeBytes: size * unitBytes })),
      })),
  );
}

/** Whole-GiB sizes, so tier capacities differ by whole GiB and are never merged. */
const gibDrivesArb = drivesArb(fc.integer({ min: MIN_DRIVE_GIB, max: MAX_DRIVE_GIB }), GIB);

/** Arbitrary byte sizes, including unaligned and nearly equal ones. */
const byteDrivesArb = drivesArb(
  fc.integer({ min: minimumDriveBytes(), max: MAX_DRIVE_TB * TB }),
  1,
);

describe('planPool properties', () => {
  it('gives a valid layout with exactly the ideal capacity for whole-GiB drives', () => {
    fc.assert(
      fc.property(gibDrivesArb, ({ redundancy, drives }) => {
        const layout = layoutOf(planPool(drives, redundancy));
        expect(layoutViolations(layout, drives)).toEqual([]);
        const capacities = drives.map((drive) => tierAreaCapacity(drive.sizeBytes));
        expect(layout.usableBytes).toBe(idealUsable(capacities, redundancy));
      }),
    );
  });

  it('gives a valid layout close to the ideal capacity for arbitrary sizes', () => {
    fc.assert(
      fc.property(byteDrivesArb, ({ redundancy, drives }) => {
        const layout = layoutOf(planPool(drives, redundancy));
        expect(layoutViolations(layout, drives)).toEqual([]);
        // Merging nearly equal drives costs each drive at most one minimum tier per merge.
        const capacities = drives.map((drive) => tierAreaCapacity(drive.sizeBytes));
        const slack = drives.length * drives.length * MIN_TIER_BYTES;
        expect(layout.usableBytes).toBeGreaterThanOrEqual(
          idealUsable(capacities, redundancy) - slack,
        );
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(byteDrivesArb, ({ redundancy, drives }) => {
        expect(planPool(drives, redundancy)).toEqual(planPool(drives, redundancy));
      }),
    );
  });
});
