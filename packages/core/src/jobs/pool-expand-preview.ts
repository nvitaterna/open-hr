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
import type { DriveState, SystemSnapshot } from '@ohr/shared/system-snapshot';

import { busyTiers, driveProblems, labelledPool } from './pool-change-checks.ts';
import type { PreviewResult } from './preview-result.ts';

function preview(
  request: PoolExpandRequest,
  snapshot: SystemSnapshot,
  candidates: readonly DriveState[],
  driveUuid: (index: number) => string,
): PreviewResult<PoolExpandInput> {
  const found = labelledPool(snapshot, request.poolId);
  if ('reasons' in found) {
    return { ok: false, reasons: found.reasons };
  }
  const { pool, uuid } = found;
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
      poolUuid: uuid,
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
