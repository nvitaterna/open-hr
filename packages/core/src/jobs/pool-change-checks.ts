/**
 * Checks shared by the previews of jobs that change an existing pool
 * (decision 0011): the pool must be known and labelled, none of its arrays
 * may be busy, and new drives must be free to use. Pure.
 */

import { derivePools, type PoolView } from '@ohr/shared/pool-view';
import type { DriveState, SystemSnapshot } from '@ohr/shared/system-snapshot';

function describeContents(drive: DriveState): string {
  const { device } = drive;
  if (drive.role === 'ohr') {
    return 'an Open HR pool';
  }
  if (device.children.length > 0) {
    return `${device.children.length} partitions`;
  }
  return device.fsType ?? 'a signature';
}

/** Arrays of the pool with a resync, recovery, reshape, check, or repair running or queued. */
export function busyTiers(pool: PoolView, snapshot: SystemSnapshot): string[] {
  const found: string[] = [];
  for (const tier of pool.tiers) {
    const sync = snapshot.mdArrays.find((array) => array.name === tier.kernelName)?.status.sync;
    if (sync !== null && sync !== undefined) {
      let progress = `is waiting to ${sync.action}`;
      if (sync.percent !== null) {
        progress = `is running a ${sync.action}, ${Math.floor(sync.percent)}% done`;
      }
      found.push(`Tier ${tier.tier} ${progress}. Wait for it to finish.`);
    }
  }
  return found;
}

/** What stops these drives from joining the pool, before planning. */
export function driveProblems(
  request: { readonly devices: readonly string[]; readonly wipe: boolean },
  pool: PoolView,
  candidates: readonly DriveState[],
): string[] {
  const found: string[] = [];
  const known = new Map(candidates.map((drive) => [drive.device.path, drive]));
  // A drive that is no longer in the pool may join again, like any drive that holds something.
  const inPool = new Set(
    pool.drives.filter((drive) => drive.membership === 'member').map((drive) => drive.path),
  );
  const seen = new Set<string>();
  for (const path of request.devices) {
    const drive = known.get(path);
    if (seen.has(path)) {
      found.push(`${path} is listed more than once.`);
    } else if (drive === undefined) {
      found.push(`${path} is not a physical drive on this machine.`);
    } else if (inPool.has(path)) {
      found.push(`${path} is already in pool ${pool.id}.`);
    } else if (drive.role === 'system') {
      found.push(`${path} holds the operating system. Open HR never uses it.`);
    } else if (drive.role !== 'empty' && !request.wipe) {
      found.push(`${path} is not empty (${describeContents(drive)}). It has to be wiped first.`);
    }
    seen.add(path);
  }
  return found;
}

/** The pool, with a label to give new drives, or why there is none. */
export function labelledPool(
  snapshot: SystemSnapshot,
  poolId: string,
): { readonly pool: PoolView; readonly uuid: string } | { readonly reasons: string[] } {
  const pool = derivePools(snapshot).find((candidate) => candidate.id === poolId);
  if (pool === undefined) {
    return { reasons: [`There is no pool ${poolId}.`] };
  }
  if (pool.uuid === null) {
    return {
      reasons: [`No label of pool ${pool.id} could be read, so new drives cannot be labelled.`],
    };
  }
  return { pool, uuid: pool.uuid };
}
