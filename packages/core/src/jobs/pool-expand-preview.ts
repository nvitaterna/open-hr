/**
 * Turns a pool-expand request into the job input, or into the reasons it is
 * refused (decision 0011). Pure: it reads only the snapshot it is given.
 * Core runs it at preview time and again at submit time, so the browser and
 * the CLI get the same answer.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { describeExpansionError, planExpansion } from '@ohr/shared/expansion-planner';
import { type PoolExpandInput, poolExpandInputSchema } from '@ohr/shared/pool-expand-input';
import type { PoolExpandRequest } from '@ohr/shared/pool-expand-request';
import { readPoolLayout } from '@ohr/shared/pool-layout';
import { derivePools, type PoolView } from '@ohr/shared/pool-view';
import type { DriveState, SystemSnapshot } from '@ohr/shared/system-snapshot';

import type { PreviewResult } from './preview-result.ts';

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
function busyTiers(pool: PoolView, snapshot: SystemSnapshot): string[] {
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
function driveProblems(
  request: PoolExpandRequest,
  pool: PoolView,
  candidates: readonly DriveState[],
): string[] {
  const found: string[] = [];
  const known = new Map(candidates.map((drive) => [drive.device.path, drive]));
  const inPool = new Set(pool.drives.map((drive) => drive.path));
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

function preview(
  request: PoolExpandRequest,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
  driveUuid: (index: number) => string,
): PreviewResult<PoolExpandInput> {
  const pool = derivePools(snapshot).find((candidate) => candidate.id === request.poolId);
  if (pool === undefined) {
    return { ok: false, reasons: [`There is no pool ${request.poolId}.`] };
  }
  if (pool.uuid === null) {
    return {
      ok: false,
      reasons: [`No label of pool ${pool.id} could be read, so new drives cannot be labelled.`],
    };
  }
  const problems = [...busyTiers(pool, snapshot), ...driveProblems(request, pool, candidates)];
  if (problems.length > 0) {
    return { ok: false, reasons: problems };
  }
  const layout = readPoolLayout(snapshot, pool.id);
  if (!layout.ok) {
    return { ok: false, reasons: [layout.reason] };
  }
  const drives = request.devices.map((path) => {
    const drive = candidates.find((candidate) => candidate.device.path === path);
    if (drive === undefined) {
      throw new Error(`${path} vanished between the checks and the plan`);
    }
    return drive.device;
  });
  const plan = planExpansion(layout.layout, {
    kind: 'expand',
    newDrives: drives.map((device) => ({ id: device.path, sizeBytes: device.sizeBytes })),
  });
  if (!plan.ok) {
    return { ok: false, reasons: [describeExpansionError(plan.error)] };
  }
  return {
    ok: true,
    value: {
      poolId: pool.id,
      poolUuid: pool.uuid,
      redundancy: layout.layout.redundancy,
      wipe: request.wipe,
      newDrives: drives.map((device, index) => ({
        path: device.path,
        serial: device.serial,
        wwn: device.wwn,
        sizeBytes: device.sizeBytes,
        driveUuid: driveUuid(index),
      })),
      target: plan.plan.target,
      usableBytesBefore: plan.plan.usableBytesBefore,
      actions: [...plan.plan.actions],
    },
  };
}

/**
 * Checks the request against the snapshot and plans the change.
 * `candidates` are the drives the request may add: the snapshot's drives,
 * plus loop devices when testing.
 */
export function previewPoolExpand(
  request: PoolExpandRequest,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
): PreviewResult<PoolExpandInput> {
  return preview(request, snapshot, candidates, () => randomUUID());
}

/**
 * Checks a submitted input: the same checks as the preview, against the
 * system as it is now, and the input must be exactly what a fresh preview
 * would build. A client cannot hand core a plan it did not make.
 */
export function recheckPoolExpand(
  input: PoolExpandInput,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
): string[] {
  const request: PoolExpandRequest = {
    poolId: input.poolId,
    devices: input.newDrives.map((drive) => drive.path),
    wipe: input.wipe,
  };
  const fresh = preview(
    request,
    snapshot,
    candidates,
    (index) => input.newDrives[index]?.driveUuid ?? '',
  );
  if (!fresh.ok) {
    return [...fresh.reasons];
  }
  // Both through the schema, so fields the schema does not carry cannot make them differ.
  if (
    !isDeepStrictEqual(poolExpandInputSchema.parse(fresh.value), poolExpandInputSchema.parse(input))
  ) {
    return ['The submitted change does not match a fresh preview of this pool. Preview it again.'];
  }
  return [];
}
