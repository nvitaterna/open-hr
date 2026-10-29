/**
 * Turns a pool-create request into the job input, or into the reasons it is
 * refused (safety rules 2 and 3, decision 0007). Pure: it reads only the
 * snapshot it is given. Core runs it at preview time and again at submit
 * time, so the browser and the CLI get the same answer.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { mdArrayName, volumeGroupName } from '@ohr/shared/naming';
import { describePlanError, planPool } from '@ohr/shared/planner';
import { type PoolCreateInput, poolCreateInputSchema } from '@ohr/shared/pool-create-input';
import type { PoolCreateRequest } from '@ohr/shared/pool-create-request';
import type { DriveState, SystemSnapshot } from '@ohr/shared/system-snapshot';

import type { PreviewResult } from './preview-result.ts';

/** Where new UUIDs come from. Re-checking a submitted input supplies the ones it already has. */
interface UuidSource {
  readonly pool: () => string;
  readonly drive: (index: number) => string;
}

const RANDOM_UUIDS: UuidSource = { pool: randomUUID, drive: () => randomUUID() };

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

/** What stops the pool from being created on these drives, or nothing. */
function problems(
  request: PoolCreateRequest,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
): string[] {
  const found: string[] = [];
  const known = new Map(candidates.map((drive) => [drive.device.path, drive]));
  const seen = new Set<string>();
  for (const path of request.devices) {
    const drive = known.get(path);
    if (seen.has(path)) {
      found.push(`${path} is listed more than once.`);
    } else if (drive === undefined) {
      found.push(`${path} is not a physical drive on this machine.`);
    } else if (drive.role === 'system') {
      found.push(`${path} holds the operating system. Open HR never uses it.`);
    } else if (drive.role !== 'empty' && !request.wipe) {
      found.push(`${path} is not empty (${describeContents(drive)}). It has to be wiped first.`);
    }
    seen.add(path);
  }
  const group = volumeGroupName(request.poolId);
  if (snapshot.volumeGroups.some((candidate) => candidate.name === group)) {
    found.push(`Volume group ${group} already exists. Choose another pool id.`);
  }
  const arrayPrefix = mdArrayName(request.poolId, 1).slice(0, -1);
  if (snapshot.mdArrays.some((array) => array.detail?.devName?.startsWith(arrayPrefix) === true)) {
    found.push(`Arrays named ${arrayPrefix}* already exist. Choose another pool id.`);
  }
  return found;
}

function buildInput(
  request: PoolCreateRequest,
  candidates: readonly DriveState[],
  uuids: UuidSource,
): PreviewResult<PoolCreateInput> {
  const drives = request.devices.map((path) => {
    const drive = candidates.find((candidate) => candidate.device.path === path);
    if (drive === undefined) {
      throw new Error(`${path} vanished between the checks and the plan`);
    }
    return drive;
  });
  const plan = planPool(
    drives.map((drive) => ({ id: drive.device.path, sizeBytes: drive.device.sizeBytes })),
    request.redundancy,
  );
  if (!plan.ok) {
    return { ok: false, reasons: [describePlanError(plan.error)] };
  }
  return {
    ok: true,
    value: {
      poolId: request.poolId,
      poolUuid: uuids.pool(),
      redundancy: request.redundancy,
      wipe: request.wipe,
      drives: drives.map((drive, index) => ({
        path: drive.device.path,
        serial: drive.device.serial,
        wwn: drive.device.wwn,
        sizeBytes: drive.device.sizeBytes,
        driveUuid: uuids.drive(index),
      })),
      layout: plan.layout,
    },
  };
}

function preview(
  request: PoolCreateRequest,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
  uuids: UuidSource,
): PreviewResult<PoolCreateInput> {
  const found = problems(request, snapshot, candidates);
  if (found.length > 0) {
    return { ok: false, reasons: found };
  }
  return buildInput(request, candidates, uuids);
}

/**
 * Checks the request against the snapshot and plans the pool. `candidates`
 * are the drives the request may use: the snapshot's drives, plus loop
 * devices when testing.
 */
export function previewPoolCreate(
  request: PoolCreateRequest,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
): PreviewResult<PoolCreateInput> {
  return preview(request, snapshot, candidates, RANDOM_UUIDS);
}

/**
 * Checks a submitted input: the same checks as the preview, against the
 * system as it is now, and the input must be exactly what a fresh preview
 * would build. A client cannot hand core a layout it did not plan.
 */
export function recheckPoolCreate(
  input: PoolCreateInput,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
): string[] {
  const request: PoolCreateRequest = {
    poolId: input.poolId,
    redundancy: input.redundancy,
    devices: input.drives.map((drive) => drive.path),
    wipe: input.wipe,
  };
  const fresh = preview(request, snapshot, candidates, {
    pool: () => input.poolUuid,
    drive: (index) => input.drives[index]?.driveUuid ?? '',
  });
  if (!fresh.ok) {
    return [...fresh.reasons];
  }
  // Both through the schema, so fields the schema does not carry cannot make them differ.
  if (
    !isDeepStrictEqual(poolCreateInputSchema.parse(fresh.value), poolCreateInputSchema.parse(input))
  ) {
    return ['The submitted pool does not match a fresh preview of these drives. Preview it again.'];
  }
  return [];
}
