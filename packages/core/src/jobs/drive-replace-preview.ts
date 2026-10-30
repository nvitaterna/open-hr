/**
 * Turns a drive-replace request into the job input, or into the reasons it
 * is refused (decision 0011). Pure: it reads only the snapshot it is given.
 * Core runs it at preview time and again at submit time.
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { type DriveReplaceInput, driveReplaceInputSchema } from '@ohr/shared/drive-replace-input';
import type { DriveReplaceRequest } from '@ohr/shared/drive-replace-request';
import { describeExpansionError, planExpansion } from '@ohr/shared/expansion-planner';
import { readPoolLayout } from '@ohr/shared/pool-layout';
import type { DriveState, SystemSnapshot } from '@ohr/shared/system-snapshot';

import { busyTiers, driveProblems, labelledPool } from './pool-change-checks.ts';
import type { PreviewResult } from './preview-result.ts';

function preview(
  request: DriveReplaceRequest,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
  driveUuid: string,
): PreviewResult<DriveReplaceInput> {
  const found = labelledPool(snapshot, request.poolId);
  if ('reasons' in found) {
    return { ok: false, reasons: found.reasons };
  }
  const { pool, uuid } = found;
  const problems = [
    ...busyTiers(pool, snapshot),
    ...driveProblems({ devices: [request.newDrive], wipe: request.wipe }, pool, candidates),
  ];
  if (problems.length > 0) {
    return { ok: false, reasons: problems };
  }
  const layout = readPoolLayout(snapshot, pool.id);
  if (!layout.ok) {
    return { ok: false, reasons: [layout.reason] };
  }
  const device = candidates.find((drive) => drive.device.path === request.newDrive)?.device;
  if (device === undefined) {
    throw new Error(`${request.newDrive} vanished between the checks and the plan`);
  }
  const plan = planExpansion(layout.layout, {
    kind: 'replace',
    oldDrive: request.oldDrive,
    newDrive: { id: device.path, sizeBytes: device.sizeBytes },
  });
  if (!plan.ok) {
    return { ok: false, reasons: [describeExpansionError(plan.error)] };
  }
  return {
    ok: true,
    value: {
      poolId: pool.id,
      poolUuid: uuid,
      redundancy: layout.layout.redundancy,
      wipe: request.wipe,
      oldDrive: request.oldDrive,
      newDrives: [
        {
          path: device.path,
          serial: device.serial,
          wwn: device.wwn,
          sizeBytes: device.sizeBytes,
          driveUuid,
        },
      ],
      target: plan.plan.target,
      usableBytesBefore: plan.plan.usableBytesBefore,
      actions: [...plan.plan.actions],
    },
  };
}

/**
 * Checks the request against the snapshot and plans the replacement.
 * `candidates` are the drives the new one may be: the snapshot's drives,
 * plus loop devices when testing.
 */
export function previewDriveReplace(
  request: DriveReplaceRequest,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
): PreviewResult<DriveReplaceInput> {
  return preview(request, snapshot, candidates, randomUUID());
}

/** Checks a submitted input: it must be exactly what a fresh preview builds now. */
export function recheckDriveReplace(
  input: DriveReplaceInput,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
): string[] {
  const [newDrive] = input.newDrives;
  if (newDrive === undefined) {
    return ['The submitted replacement has no new drive.'];
  }
  const request: DriveReplaceRequest = {
    poolId: input.poolId,
    oldDrive: input.oldDrive,
    newDrive: newDrive.path,
    wipe: input.wipe,
  };
  const fresh = preview(request, snapshot, candidates, newDrive.driveUuid);
  if (!fresh.ok) {
    return [...fresh.reasons];
  }
  if (
    !isDeepStrictEqual(
      driveReplaceInputSchema.parse(fresh.value),
      driveReplaceInputSchema.parse(input),
    )
  ) {
    return ['The submitted replacement does not match a fresh preview. Preview it again.'];
  }
  return [];
}
