/**
 * Reads the layout of an existing pool from a system snapshot (decision
 * 0011): where each tier sits on its drives, its md level and members, and
 * how big its array and physical volume are. The machine stays the source
 * of truth; nothing here is remembered. A pool Open HR did not build the
 * regular way is refused with a reason, so the expansion planner only ever
 * plans for layouts it understands.
 */

import type { RaidLevel } from './array-capacity.ts';
import {
  FIRST_PARTITION_OFFSET_BYTES,
  LABEL_PARTITION_BYTES,
  type Redundancy,
} from './constants.ts';
import { parsePartitionLabel } from './naming.ts';
import { derivePools, type MemberState, type PoolView, type TierView } from './pool-view.ts';
import type { SystemSnapshot } from './system-snapshot.ts';
import { LABEL_PARTITION_NUMBER, TIER_AREA_OFFSET_BYTES } from './tier-rules.ts';

const LEVELS: ReadonlySet<string> = new Set(['raid1', 'raid5', 'raid6']);
/** Member states that hold one of the array's slots. A spare does not. */
const SLOT_STATES: ReadonlySet<MemberState> = new Set(['active', 'rebuilding', 'faulty']);

/** A reason the layout cannot be read, or the value. */
type Read<T> = T | { readonly problem: string };

function isProblem<T>(value: Read<T>): value is { readonly problem: string } {
  return typeof value === 'object' && value !== null && 'problem' in value;
}

function memberDrives(pool: PoolView): Set<string> {
  return new Set(
    pool.tiers.flatMap((tier) =>
      tier.members.filter((member) => SLOT_STATES.has(member.state)).map((member) => member.drive),
    ),
  );
}

function readDrive(drive: SystemSnapshot['drives'][number], poolId: string): Read<CurrentDrive> {
  const partitions: CurrentPartition[] = [];
  for (const child of drive.device.children) {
    const role = parsePartitionLabel(child.partLabel ?? '');
    if (role?.poolId === poolId) {
      if (child.partNumber === null || child.startBytes === null) {
        return { problem: `lsblk did not report the number and start of ${child.path}.` };
      }
      let tier: number | null = null;
      if (role.kind === 'tier') {
        ({ tier } = role);
      }
      partitions.push({
        number: child.partNumber,
        role: role.kind,
        tier,
        startBytes: child.startBytes,
        sizeBytes: child.sizeBytes,
      });
    }
  }
  partitions.sort((a, b) => a.number - b.number);
  return { id: drive.device.path, sizeBytes: drive.device.sizeBytes, partitions };
}

function readTier(
  view: TierView,
  snapshot: SystemSnapshot,
  drives: readonly CurrentDrive[],
): Read<CurrentTier> {
  const where = `Tier ${view.tier}`;
  if (view.kernelName === null || view.sizeBytes === null) {
    return { problem: `${where}'s array is not running.` };
  }
  if (view.level === null || !LEVELS.has(view.level)) {
    return {
      problem: `${where}'s array is ${view.level ?? 'of an unknown level'}, which Open HR does not build.`,
    };
  }
  const devices = new Set([`/dev/${view.kernelName}`, view.arrayPath]);
  const volume = snapshot.physicalVolumes.find((candidate) => devices.has(candidate.device));
  if (volume?.firstExtentBytes === null || volume === undefined) {
    return { problem: `${where}'s array is not an LVM physical volume.` };
  }
  const members = view.members.filter((member) => SLOT_STATES.has(member.state));
  const partitions = drives.flatMap((drive) =>
    drive.partitions.filter(
      (partition) =>
        partition.tier === view.tier && members.some((member) => member.drive === drive.id),
    ),
  );
  const [first] = partitions;
  if (first === undefined) {
    return { problem: `${where} has no member partitions.` };
  }
  if (
    partitions.some((p) => p.startBytes !== first.startBytes || p.sizeBytes !== first.sizeBytes)
  ) {
    return { problem: `${where}'s partitions are not the same on every drive.` };
  }
  return {
    tier: view.tier,
    partitionNumber: first.number,
    level: view.level as RaidLevel,
    offsetBytes: first.startBytes - TIER_AREA_OFFSET_BYTES,
    sliceBytes: first.sizeBytes,
    members: members.map((member) => ({ drive: member.drive, state: member.state })),
    missingMembers: Math.max(0, (view.expectedMembers ?? members.length) - members.length),
    arrayBytes: view.sizeBytes,
    firstExtentBytes: volume.firstExtentBytes,
  };
}

function partitionProblem(drive: CurrentDrive): string | null {
  for (const partition of drive.partitions) {
    const where = `${drive.id} partition ${partition.number}`;
    if (partition.role === 'label') {
      const regular =
        partition.number === LABEL_PARTITION_NUMBER &&
        partition.startBytes === FIRST_PARTITION_OFFSET_BYTES &&
        partition.sizeBytes === LABEL_PARTITION_BYTES;
      if (!regular) {
        return `${where} is a label partition in an unexpected place.`;
      }
    } else if (partition.number !== LABEL_PARTITION_NUMBER + (partition.tier ?? 0)) {
      return `${where} holds tier ${partition.tier}, which belongs in partition ${LABEL_PARTITION_NUMBER + (partition.tier ?? 0)}.`;
    }
  }
  return null;
}

/** Tiers numbered from 1 with no gaps, each starting where the one below ends. */
function tierProblem(tiers: readonly CurrentTier[]): string | null {
  let expectedOffset = 0;
  for (const [index, tier] of tiers.entries()) {
    if (tier.tier !== index + 1) {
      return `Tier ${index + 1} is missing.`;
    }
    if (tier.offsetBytes !== expectedOffset) {
      return `Tier ${tier.tier} does not start where tier ${tier.tier - 1} ends.`;
    }
    expectedOffset += tier.sliceBytes;
  }
  return null;
}

/** Every drive is in tiers 1 to some k, never in a tier without the ones below it. */
function membershipProblem(
  drives: readonly CurrentDrive[],
  tiers: readonly CurrentTier[],
): string | null {
  for (const drive of drives) {
    const joined = tiers.map((tier) => tier.members.some((member) => member.drive === drive.id));
    const top = joined.lastIndexOf(true);
    if (joined.slice(0, top).includes(false)) {
      return `${drive.id} is in tier ${top + 1} but not in every tier below it.`;
    }
  }
  return null;
}

function readTiers(
  pool: PoolView,
  snapshot: SystemSnapshot,
  drives: readonly CurrentDrive[],
): Read<CurrentTier[]> {
  const tiers: CurrentTier[] = [];
  for (const view of pool.tiers) {
    const tier = readTier(view, snapshot, drives);
    if (isProblem(tier)) {
      return tier;
    }
    tiers.push(tier);
  }
  const problem =
    drives.map(partitionProblem).find((found) => found !== null) ??
    tierProblem(tiers) ??
    membershipProblem(drives, tiers);
  if (problem !== null) {
    return { problem };
  }
  return tiers;
}

export interface CurrentPartition {
  readonly number: number;
  readonly role: 'label' | 'tier';
  readonly tier: number | null;
  readonly startBytes: number;
  readonly sizeBytes: number;
}

export interface CurrentDrive {
  /** The drive's device path. */
  readonly id: string;
  readonly sizeBytes: number;
  readonly partitions: readonly CurrentPartition[];
}

export interface CurrentMember {
  readonly drive: string;
  readonly state: MemberState;
}

export interface CurrentTier {
  readonly tier: number;
  readonly partitionNumber: number;
  readonly level: RaidLevel;
  /** Where the tier's partitions start, from the start of the tier area. */
  readonly offsetBytes: number;
  readonly sliceBytes: number;
  /** Drives whose partition holds one of the array's slots. */
  readonly members: readonly CurrentMember[];
  /** Slots the array expects that no present partition fills. */
  readonly missingMembers: number;
  readonly arrayBytes: number;
  /** Where LVM's first extent starts on the array, from pvs. */
  readonly firstExtentBytes: number;
}

export interface CurrentLayout {
  readonly poolId: string;
  readonly redundancy: Redundancy;
  /** Drives with at least one partition in one of the pool's arrays. */
  readonly drives: readonly CurrentDrive[];
  readonly tiers: readonly CurrentTier[];
}

export type LayoutReadResult =
  | { readonly ok: true; readonly layout: CurrentLayout }
  | { readonly ok: false; readonly reason: string };

/** The pool's layout as the machine has it, or why it cannot be planned for. */
export function readPoolLayout(snapshot: SystemSnapshot, poolId: string): LayoutReadResult {
  const pool = derivePools(snapshot).find((candidate) => candidate.id === poolId);
  if (pool === undefined) {
    return { ok: false, reason: `There is no pool ${poolId}.` };
  }
  if (pool.redundancy === null) {
    return {
      ok: false,
      reason: `No label of pool ${poolId} could be read, so its redundancy is unknown.`,
    };
  }
  const inUse = memberDrives(pool);
  const drives: CurrentDrive[] = [];
  for (const drive of snapshot.drives.filter((candidate) => inUse.has(candidate.device.path))) {
    const read = readDrive(drive, poolId);
    if (isProblem(read)) {
      return { ok: false, reason: read.problem };
    }
    drives.push(read);
  }
  const tiers = readTiers(pool, snapshot, drives);
  if (isProblem(tiers)) {
    return { ok: false, reason: tiers.problem };
  }
  return { ok: true, layout: { poolId, redundancy: pool.redundancy, drives, tiers } };
}
