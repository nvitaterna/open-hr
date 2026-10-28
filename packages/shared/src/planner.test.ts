import { describe, expect, it } from 'vitest';

import type { Redundancy } from './constants.ts';
import { describePlanError, minimumDriveBytes, planPool } from './planner.ts';
import { drives, GIB, layoutOf, MIB, TB, tierAreaCapacity } from './planner-test-helpers.ts';

describe('planPool: capacity table from the plan, appendix A', () => {
  it.each<[number[], Redundancy, number]>([
    [[4, 4], 'shr1', 4],
    [[4, 8], 'shr1', 4],
    [[4, 8, 8], 'shr1', 12],
    [[4, 8, 8, 12], 'shr1', 20],
    [[4, 8, 8, 12], 'shr2', 12],
    [[4, 8, 12, 12], 'shr1', 24],
    [[4, 8, 12, 12], 'shr2', 12],
    [[8, 8, 8, 8], 'shr1', 24],
    [[8, 8, 8, 8], 'shr2', 16],
    [[2, 4, 6, 8, 10], 'shr1', 20],
    [[2, 4, 6, 8, 10], 'shr2', 12],
  ])('%j as %s gives about %d TB', (sizes, redundancy, expectedTb) => {
    const layout = layoutOf(planPool(drives(sizes), redundancy));
    // Each drive loses well under 1 GB to the GPT area, label partition, and end reserve.
    expect(layout.usableBytes).toBeLessThanOrEqual(expectedTb * TB);
    expect(layout.usableBytes).toBeGreaterThan(expectedTb * TB - sizes.length * GIB);
  });
});

describe('planPool: worked example from the plan, 4, 8, 8, 12 TB as SHR-1', () => {
  const layout = layoutOf(planPool(drives([4, 8, 8, 12]), 'shr1'));

  it('builds two RAID5 tiers and leaves the 12 TB excess unused', () => {
    expect(layout.tiers.map((tier) => [tier.level, tier.members])).toEqual([
      ['raid5', ['d0', 'd1', 'd2', 'd3']],
      ['raid5', ['d1', 'd2', 'd3']],
    ]);
    expect(layout.drives[3]?.unusedBytes).toBe(
      tierAreaCapacity(12 * TB) - tierAreaCapacity(8 * TB),
    );
    expect(layout.drives[0]?.unusedBytes).toBe(0);
  });

  it('gives each tier the partition after the label partition', () => {
    const numbers = layout.drives.map((drive) =>
      drive.partitions.map((partition) => [partition.number, partition.role, partition.tier]),
    );
    expect(numbers[0]).toEqual([
      [1, 'label', null],
      [2, 'tier', 1],
    ]);
    expect(numbers[3]).toEqual([
      [1, 'label', null],
      [2, 'tier', 1],
      [3, 'tier', 2],
    ]);
  });

  it('places the label partition at 1 MiB and tier 1 right after it', () => {
    const partitions = layout.drives[0]?.partitions ?? [];
    expect(partitions[0]?.startBytes).toBe(MIB);
    expect(partitions[0]?.sizeBytes).toBe(16 * MIB);
    expect(partitions[1]?.startBytes).toBe(17 * MIB);
  });
});

describe('planPool: level selection', () => {
  it('mirrors two drives under SHR-1', () => {
    const layout = layoutOf(planPool(drives([4, 4]), 'shr1'));
    expect(layout.tiers.map((tier) => tier.level)).toEqual(['raid1']);
  });

  it('uses a three-way mirror for a three-member tier under SHR-2', () => {
    const layout = layoutOf(planPool(drives([4, 8, 8, 8]), 'shr2'));
    expect(layout.tiers.map((tier) => [tier.level, tier.members.length])).toEqual([
      ['raid6', 4],
      ['raid1', 3],
    ]);
  });

  it('turns a two-member tier into RAID1 under SHR-1 when it is the top tier', () => {
    const layout = layoutOf(planPool(drives([4, 8, 8]), 'shr1'));
    expect(layout.tiers.map((tier) => tier.level)).toEqual(['raid5', 'raid1']);
  });
});

describe('planPool: nearly equal drives', () => {
  it('treats drives that differ by less than the minimum tier as the same size', () => {
    const layout = layoutOf(
      planPool(
        [
          { id: 'a', sizeBytes: 4 * TB },
          { id: 'b', sizeBytes: 4 * TB - 500 * MIB },
          { id: 'c', sizeBytes: 4 * TB + 300 * MIB },
        ],
        'shr1',
      ),
    );
    expect(layout.tiers).toHaveLength(1);
    expect(layout.tiers[0]?.members).toEqual(['a', 'b', 'c']);
    expect(layout.tiers[0]?.sliceBytes).toBe(tierAreaCapacity(4 * TB - 500 * MIB));
  });
});

describe('planPool: rejected input', () => {
  it('needs two drives for SHR-1 and four for SHR-2', () => {
    expect(planPool(drives([4]), 'shr1')).toEqual({
      ok: false,
      error: { code: 'too-few-drives', required: 2, actual: 1 },
    });
    expect(planPool(drives([4, 4, 4]), 'shr2')).toEqual({
      ok: false,
      error: { code: 'too-few-drives', required: 4, actual: 3 },
    });
  });

  it('rejects a drive given twice', () => {
    const result = planPool(
      [
        { id: 'a', sizeBytes: TB },
        { id: 'a', sizeBytes: TB },
      ],
      'shr1',
    );
    expect(result).toEqual({ ok: false, error: { code: 'duplicate-drive', driveId: 'a' } });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects size %d', (sizeBytes) => {
    const result = planPool(
      [
        { id: 'a', sizeBytes: TB },
        { id: 'b', sizeBytes },
      ],
      'shr1',
    );
    expect(result).toEqual({ ok: false, error: { code: 'invalid-size', driveId: 'b' } });
  });

  it('rejects drives below the minimum size, and accepts one exactly at it', () => {
    const minimum = minimumDriveBytes();
    const tooSmall = planPool(
      [
        { id: 'a', sizeBytes: TB },
        { id: 'b', sizeBytes: minimum - MIB },
      ],
      'shr1',
    );
    expect(tooSmall).toEqual({
      ok: false,
      error: { code: 'drive-too-small', driveId: 'b', minimumBytes: minimum },
    });
    const justEnough = planPool(
      [
        { id: 'a', sizeBytes: minimum },
        { id: 'b', sizeBytes: minimum },
      ],
      'shr1',
    );
    expect(justEnough.ok).toBe(true);
  });

  it('describes every error in words', () => {
    expect(describePlanError({ code: 'too-few-drives', required: 4, actual: 3 })).toContain(
      'at least 4 drives',
    );
    expect(describePlanError({ code: 'duplicate-drive', driveId: 'x' })).toContain('"x"');
    expect(describePlanError({ code: 'invalid-size', driveId: 'x' })).toContain('invalid size');
    expect(describePlanError({ code: 'drive-too-small', driveId: 'x', minimumBytes: 5 })).toContain(
      'too small',
    );
  });
});
