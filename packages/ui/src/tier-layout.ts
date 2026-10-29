/**
 * Where each tier's partitions sit on each drive, for the pool page's
 * diagram (plan section 5.6): drives as columns, tiers as bands stacked from
 * the bottom. A tier's slice is its array size over its data members, so the
 * bands are to scale. When an array is not running its size is unknown, and
 * every slice is drawn the same height instead.
 */

import { dataMembers, type RaidLevel } from '@ohr/shared/array-capacity';
import type { MemberState, PoolView, TierHealth } from '@ohr/shared/pool-view';

const RAID_LEVELS: ReadonlySet<string> = new Set(['raid1', 'raid5', 'raid6']);
/** The height of one slice when the sizes are not known. */
const NOMINAL_SLICE = 1;

function isRaidLevel(level: string | null): level is RaidLevel {
  return level !== null && RAID_LEVELS.has(level);
}

/** Bytes of one member's slice, or null when the array is not running. */
function sliceBytes(tier: PoolView['tiers'][number]): number | null {
  if (tier.sizeBytes === null || !isRaidLevel(tier.level)) {
    return null;
  }
  const members = tier.expectedMembers ?? tier.members.length;
  const data = dataMembers(tier.level, members);
  if (data <= 0) {
    return null;
  }
  return tier.sizeBytes / data;
}

export interface DiagramCell {
  readonly tier: number;
  readonly state: MemberState;
  /** The tier partition, such as /dev/sda3. */
  readonly partition: string;
  /** Distance from the bottom of the drive, in the diagram's units. */
  readonly offset: number;
  readonly height: number;
}

export interface DiagramColumn {
  readonly drive: string;
  /** The drive's size in the diagram's units. Null for a drive that is missing. */
  readonly height: number | null;
  readonly sizeBytes: number | null;
  readonly cells: DiagramCell[];
}

export interface DiagramTier {
  readonly tier: number;
  readonly level: string | null;
  readonly health: TierHealth;
}

export interface TierDiagram {
  readonly columns: DiagramColumn[];
  readonly tiers: DiagramTier[];
  /** The tallest column or stack, which the drawing scales to. */
  readonly scale: number;
  /** False when some array's size is unknown and slices are drawn equal. */
  readonly toScale: boolean;
}

/** Lays out the pool's tiers on its drives. */
export function layoutTiers(pool: PoolView): TierDiagram {
  const tiers = [...pool.tiers].sort((a, b) => a.tier - b.tier);
  const slices = tiers.map(sliceBytes);
  const toScale = slices.every((slice) => slice !== null);
  const sizes = new Map(pool.drives.map((drive) => [drive.path, drive.sizeBytes]));
  const order = [...sizes.keys()];
  for (const tier of tiers) {
    for (const member of tier.members) {
      if (!order.includes(member.drive)) {
        order.push(member.drive);
      }
    }
  }
  const columns = order.map((drive): DiagramColumn => {
    const sizeBytes = sizes.get(drive) ?? null;
    let height: number | null = null;
    if (toScale && sizeBytes !== null) {
      height = sizeBytes;
    }
    return { drive, height, sizeBytes, cells: [] };
  });
  for (const [index, tier] of tiers.entries()) {
    let height = NOMINAL_SLICE;
    if (toScale) {
      height = slices[index] ?? NOMINAL_SLICE;
    }
    for (const member of tier.members) {
      const column = columns.find((candidate) => candidate.drive === member.drive);
      const offset = column?.cells.reduce((top, cell) => top + cell.height, 0) ?? 0;
      column?.cells.push({
        tier: tier.tier,
        state: member.state,
        partition: member.partition,
        offset,
        height,
      });
    }
  }
  const stacks = columns.map((column) =>
    Math.max(column.height ?? 0, ...column.cells.map((cell) => cell.offset + cell.height)),
  );
  return {
    columns,
    tiers: tiers.map((tier) => ({ tier: tier.tier, level: tier.level, health: tier.health })),
    scale: Math.max(NOMINAL_SLICE, ...stacks),
    toScale,
  };
}
