import { describe, expect, it } from 'vitest';

import { planExpansion } from './expansion-planner.ts';
import { planOf, poolOf, withMember } from './expansion-test-helpers.ts';
import { MIB, TB } from './planner-test-helpers.ts';

function replace(oldDrive: string | null, sizeTb: number) {
  return { kind: 'replace' as const, oldDrive, newDrive: { id: 'n0', sizeBytes: sizeTb * TB } };
}

describe('planExpansion: replacing a drive', () => {
  const current = poolOf([4, 8, 8]);

  it('copies a healthy drive onto the new one tier by tier', () => {
    const plan = planOf(planExpansion(current, replace('d1', 8)));
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'partition-drive', drive: 'n0' }),
      { kind: 'replace-member', tier: 1, oldDrive: 'd1', newDrive: 'n0', mode: 'live' },
      { kind: 'replace-member', tier: 2, oldDrive: 'd1', newDrive: 'n0', mode: 'live' },
    ]);
    expect(plan.target.usableBytes).toBe(plan.usableBytesBefore);
    expect(plan.target.drives.map((drive) => drive.id)).toEqual(['d0', 'd2', 'n0']);
    expect(plan.target.tiers[1]?.members).toEqual(['d2', 'n0']);
  });

  it('rebuilds onto the new drive when the old one has failed', () => {
    const plan = planOf(planExpansion(withMember(current, 'd2', 'faulty'), replace('d2', 8)));
    expect(plan.actions.slice(1).map((action) => 'mode' in action && action.mode)).toEqual([
      'rebuild',
      'rebuild',
    ]);
  });

  it('rebuilds only the tier where the drive failed and copies it live in the others', () => {
    const plan = planOf(planExpansion(withMember(current, 'd2', 'faulty', 1), replace('d2', 8)));
    expect(plan.actions.slice(1).map((action) => 'mode' in action && action.mode)).toEqual([
      'rebuild',
      'live',
    ]);
  });

  it('rebuilds the missing drive when none is named', () => {
    const plan = planOf(planExpansion(withMember(current, 'd0', 'gone'), replace(null, 4)));
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'partition-drive', drive: 'n0' }),
      { kind: 'replace-member', tier: 1, oldDrive: null, newDrive: 'n0', mode: 'rebuild' },
    ]);
  });

  it('takes only the old drive’s tiers on a larger drive and leaves the rest for an expand', () => {
    const plan = planOf(planExpansion(current, replace('d0', 8)));
    const added = plan.target.drives.find((drive) => drive.id === 'n0');
    expect(added?.partitions.map((partition) => partition.number)).toEqual([1, 2]);
    expect(added?.unusedBytes).toBeGreaterThan(3 * TB);
  });

  it('accepts a replacement a few MiB smaller than the old drive', () => {
    const newDrive = { id: 'n0', sizeBytes: 8 * TB - 10 * MIB };
    expect(planExpansion(current, { kind: 'replace', oldDrive: 'd1', newDrive }).ok).toBe(true);
  });

  it('refuses a replacement without room for every tier the old drive had', () => {
    const result = planExpansion(current, replace('d1', 4));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'replacement-too-small', driveId: 'n0' },
    });
  });

  it('refuses a drive that is not in the pool', () => {
    expect(planExpansion(current, replace('d9', 8))).toEqual({
      ok: false,
      error: { code: 'unknown-drive', driveId: 'd9' },
    });
  });

  it('refuses to guess when nothing is missing', () => {
    expect(planExpansion(current, replace(null, 8))).toEqual({
      ok: false,
      error: { code: 'no-missing-drive' },
    });
  });

  it('refuses while another drive is also failing', () => {
    const twice = withMember(withMember(current, 'd0', 'faulty'), 'd1', 'faulty');
    expect(planExpansion(twice, replace('d1', 8))).toEqual({
      ok: false,
      error: { code: 'pool-degraded', tier: 1 },
    });
  });
});
