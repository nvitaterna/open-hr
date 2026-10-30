import { describe, expect, it } from 'vitest';

import type { MemberState, PoolView, TierView } from '@ohr/shared/pool-view';

import { layoutTiers } from './tier-layout.ts';

const TB = 1_000_000_000_000;

function tier(
  number: number,
  level: string,
  sizeBytes: number | null,
  members: [string, MemberState][],
): TierView {
  return {
    tier: number,
    arrayPath: `/dev/md/ohr_tank_t${number}`,
    kernelName: null,
    level,
    sizeBytes,
    expectedMembers: members.length,
    health: 'healthy',
    sync: null,
    members: members.map(([drive, state]) => ({
      drive,
      partition: `${drive}${number + 1}`,
      state,
    })),
  };
}

function pool(drives: [string, number][], tiers: TierView[]): PoolView {
  return {
    id: 'tank',
    uuid: null,
    redundancy: 'shr1',
    health: 'healthy',
    sizeBytes: null,
    freeBytes: null,
    drives: drives.map(([path, sizeBytes]) => ({
      path,
      model: null,
      serial: null,
      sizeBytes,
      driveUuid: null,
      label: 'ok',
      membership: 'member',
    })),
    tiers,
    volumes: [],
    warnings: [],
  };
}

describe('layoutTiers', () => {
  it('stacks each tier on its drives, to scale', () => {
    const diagram = layoutTiers(
      pool(
        [
          ['/dev/sda', 2 * TB],
          ['/dev/sdb', 4 * TB],
          ['/dev/sdc', 4 * TB],
        ],
        [
          // Listed out of order: tier 1 still goes at the bottom.
          tier(2, 'raid1', 2 * TB, [
            ['/dev/sdb', 'active'],
            ['/dev/sdc', 'active'],
          ]),
          tier(1, 'raid5', 4 * TB, [
            ['/dev/sda', 'active'],
            ['/dev/sdb', 'active'],
            ['/dev/sdc', 'rebuilding'],
          ]),
        ],
      ),
    );
    expect(diagram.toScale).toBe(true);
    expect(diagram.scale).toBe(4 * TB);
    expect(diagram.tiers.map((entry) => entry.tier)).toEqual([1, 2]);
    expect(
      diagram.columns.map((column) => [
        column.drive,
        column.height,
        column.cells.map((cell) => [cell.tier, cell.offset, cell.height, cell.state]),
      ]),
    ).toEqual([
      ['/dev/sda', 2 * TB, [[1, 0, 2 * TB, 'active']]],
      [
        '/dev/sdb',
        4 * TB,
        [
          [1, 0, 2 * TB, 'active'],
          [2, 2 * TB, 2 * TB, 'active'],
        ],
      ],
      [
        '/dev/sdc',
        4 * TB,
        [
          [1, 0, 2 * TB, 'rebuilding'],
          [2, 2 * TB, 2 * TB, 'active'],
        ],
      ],
    ]);
  });
});

describe('layoutTiers with missing pieces', () => {
  it('adds a column for a member whose drive is gone', () => {
    const diagram = layoutTiers(
      pool(
        [['/dev/sda', TB]],
        [
          tier(1, 'raid1', TB, [
            ['/dev/sda', 'active'],
            ['/dev/sdz', 'missing'],
          ]),
        ],
      ),
    );
    expect(diagram.columns.map((column) => [column.drive, column.sizeBytes])).toEqual([
      ['/dev/sda', TB],
      ['/dev/sdz', null],
    ]);
    expect(diagram.columns[1]?.cells[0]?.state).toBe('missing');
  });

  it('draws every slice the same height when an array is not running', () => {
    const diagram = layoutTiers(
      pool(
        [
          ['/dev/sda', TB],
          ['/dev/sdb', 2 * TB],
        ],
        [
          tier(1, 'raid1', TB, [
            ['/dev/sda', 'active'],
            ['/dev/sdb', 'active'],
          ]),
          tier(2, 'raid1', null, [['/dev/sdb', 'active']]),
        ],
      ),
    );
    expect(diagram.toScale).toBe(false);
    expect(diagram.scale).toBe(2);
    expect(diagram.columns[1]?.cells.map((cell) => [cell.offset, cell.height])).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });
});
