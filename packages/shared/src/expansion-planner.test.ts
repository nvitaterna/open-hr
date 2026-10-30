import { describe, expect, it } from 'vitest';

import { arrayBytesFor } from './array-capacity.ts';
import { LVM_EXTENT_BYTES } from './constants.ts';
import { describeExpansionError, planExpansion } from './expansion-planner.ts';
import { planOf, poolOf } from './expansion-test-helpers.ts';
import { planPool } from './planner.ts';
import { drives, GIB, layoutOf, MIB, TB } from './planner-test-helpers.ts';
import { alignDown } from './sizes.ts';

const NOTHING = /Nothing would change/u;
const TIER_2 = /Tier 2/u;

function add(sizesTb: readonly number[]) {
  return {
    kind: 'expand' as const,
    newDrives: sizesTb.map((size, index) => ({ id: `n${index}`, sizeBytes: size * TB })),
  };
}

function kinds(actions: readonly { kind: string; tier?: number; drive?: string }[]): string[] {
  return actions.map((action) => [action.kind, action.tier ?? action.drive].join(' '));
}

describe('planExpansion: adding drives', () => {
  it('turns a two-drive RAID1 into a three-drive RAID5', () => {
    const plan = planOf(planExpansion(poolOf([4, 4]), add([4])));
    expect(kinds(plan.actions)).toEqual([
      'partition-drive n0',
      'convert-to-raid5 1',
      'grow-tier 1',
      'resize-physical-volume 1',
    ]);
    expect(plan.target.tiers.map((tier) => [tier.level, tier.members])).toEqual([
      ['raid5', ['d0', 'd1', 'n0']],
    ]);
    // Twice the space, less the first extent the RAID1 had from the start.
    const [grown] = plan.target.tiers;
    const expected = alignDown(
      arrayBytesFor('raid5', 3, grown?.sliceBytes ?? 0) - MIB,
      LVM_EXTENT_BYTES,
    );
    expect(grown?.usableBytes).toBe(expected);
    expect(plan.target.usableBytes).toBeGreaterThan(2 * plan.usableBytesBefore - GIB);
  });

  it('grows a RAID5 without changing its level', () => {
    const plan = planOf(planExpansion(poolOf([4, 4, 4]), add([4])));
    expect(kinds(plan.actions)).toEqual([
      'partition-drive n0',
      'grow-tier 1',
      'resize-physical-volume 1',
    ]);
    expect(plan.actions[1]).toMatchObject({ level: 'raid5', add: ['n0'], members: 4 });
  });

  it('puts a larger drive in every tier it has room for and leaves the rest unused', () => {
    const plan = planOf(planExpansion(poolOf([4, 8, 8]), add([12])));
    expect(kinds(plan.actions)).toEqual([
      'partition-drive n0',
      'grow-tier 1',
      'convert-to-raid5 2',
      'grow-tier 2',
      'resize-physical-volume 1',
      'resize-physical-volume 2',
    ]);
    const added = plan.target.drives.find((drive) => drive.id === 'n0');
    expect(added?.partitions.map((partition) => partition.number)).toEqual([1, 2, 3]);
    expect(added?.unusedBytes).toBeGreaterThan(4 * TB - GIB);
  });

  it('builds a new tier when two drives have room above the highest one', () => {
    const plan = planOf(planExpansion(poolOf([4, 8, 8]), add([12, 12])));
    expect(plan.actions.at(-1)).toEqual({
      kind: 'create-tier',
      tier: 3,
      level: 'raid1',
      members: ['n0', 'n1'],
    });
    const [, , third] = plan.target.tiers;
    // 12 TB less 8 TB, aligned down to whole MiB.
    expect(third?.sliceBytes).toBeLessThanOrEqual(4 * TB);
    expect(third?.sliceBytes).toBeGreaterThan(4 * TB - MIB);
  });

  it('adds a new tier partition to an existing drive that has room', () => {
    const plan = planOf(planExpansion(poolOf([4, 4, 12]), add([12])));
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: 'add-partitions', drive: 'd2' }),
    );
    expect(plan.actions.at(-1)).toMatchObject({
      kind: 'create-tier',
      tier: 2,
      members: ['d2', 'n0'],
    });
  });

  it('takes a drive a few MiB smaller than the others into their tier, using its reserve', () => {
    const current = poolOf([4, 4, 4]);
    const sizeBytes = 4 * TB - 10 * MIB;
    const plan = planOf(
      planExpansion(current, { kind: 'expand', newDrives: [{ id: 'n0', sizeBytes }] }),
    );
    expect(plan.actions[1]).toMatchObject({ kind: 'grow-tier', add: ['n0'] });
  });

  it('never moves or resizes an existing partition', () => {
    const current = poolOf([4, 8, 8, 12]);
    const plan = planOf(planExpansion(current, add([12, 16])));
    for (const drive of current.drives) {
      const after = plan.target.drives.find((candidate) => candidate.id === drive.id);
      expect(after?.partitions.slice(0, drive.partitions.length)).toEqual(drive.partitions);
    }
  });

  it('uses leftover space with no new drives', () => {
    // d0 replaced its 4 TB drive with an 8 TB one, which can now join tier 2.
    const before = poolOf([4, 8, 8]);
    const current = {
      ...before,
      drives: before.drives.map((drive) => ({
        ...drive,
        sizeBytes: Math.max(drive.sizeBytes, 8 * TB),
      })),
    };
    const plan = planOf(planExpansion(current, { kind: 'expand', newDrives: [] }));
    expect(kinds(plan.actions)).toEqual([
      'add-partitions d0',
      'convert-to-raid5 2',
      'grow-tier 2',
      'resize-physical-volume 2',
    ]);
  });
});

describe('planExpansion: SHR-2', () => {
  it('grows a RAID6', () => {
    const plan = planOf(planExpansion(poolOf([4, 4, 4, 4], 'shr2'), add([4])));
    expect(plan.actions[1]).toMatchObject({ kind: 'grow-tier', level: 'raid6', members: 5 });
  });

  it('refuses to turn a three-copy RAID1 into RAID6', () => {
    // Tier 2 is a three-copy RAID1 of the 8 TB drives; a fourth would need RAID6.
    const result = planExpansion(poolOf([4, 8, 8, 8], 'shr2'), add([8]));
    expect(result).toEqual({ ok: false, error: { code: 'needs-raid6-conversion', tier: 2 } });
  });
});

describe('planExpansion: refusals', () => {
  const current = poolOf([4, 4, 4]);

  it('refuses when nothing would change', () => {
    expect(planExpansion(current, { kind: 'expand', newDrives: [] })).toEqual({
      ok: false,
      error: { code: 'nothing-to-do' },
    });
  });

  it('refuses a drive already in the pool', () => {
    const change = { kind: 'expand' as const, newDrives: [{ id: 'd0', sizeBytes: 4 * TB }] };
    expect(planExpansion(current, change)).toEqual({
      ok: false,
      error: { code: 'drive-in-pool', driveId: 'd0' },
    });
  });

  it('refuses the same drive twice', () => {
    const drive = { id: 'x', sizeBytes: 4 * TB };
    expect(planExpansion(current, { kind: 'expand', newDrives: [drive, drive] })).toEqual({
      ok: false,
      error: { code: 'duplicate-drive', driveId: 'x' },
    });
  });

  it('refuses a drive with no room for tier 1, and names the smallest that has', () => {
    const result = planExpansion(current, add([2]));
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'drive-too-small') {
      throw new Error('expected drive-too-small');
    }
    const { minimumBytes } = result.error;
    expect(
      planExpansion(current, { kind: 'expand', newDrives: [{ id: 'n0', sizeBytes: minimumBytes }] })
        .ok,
    ).toBe(true);
    expect(
      planExpansion(current, {
        kind: 'expand',
        newDrives: [{ id: 'n0', sizeBytes: minimumBytes - MIB }],
      }).ok,
    ).toBe(false);
  });

  it('refuses a degraded pool', () => {
    const degraded = {
      ...current,
      tiers: current.tiers.map((tier) => ({ ...tier, missingMembers: 1 })),
    };
    expect(planExpansion(degraded, add([4]))).toEqual({
      ok: false,
      error: { code: 'pool-degraded', tier: 1 },
    });
  });

  it('describes every error', () => {
    expect(describeExpansionError({ code: 'nothing-to-do' })).toMatch(NOTHING);
    expect(describeExpansionError({ code: 'needs-raid6-conversion', tier: 2 })).toMatch(TIER_2);
  });
});

describe('planExpansion: capacity', () => {
  it('reports the capacity before from the arrays as they are', () => {
    const plan = planOf(planExpansion(poolOf([4, 8, 8]), add([8])));
    expect(plan.usableBytesBefore).toBe(layoutOf(planPool(drives([4, 8, 8]), 'shr1')).usableBytes);
    expect(plan.target.usableBytes).toBeGreaterThan(plan.usableBytesBefore);
  });
});
