/**
 * Turns a volume-grow request into the job input, or into the reasons it is
 * refused (decision 0011). Pure: it reads only the snapshot it is given.
 * Core runs it at preview time and again at submit time.
 */

import { isDeepStrictEqual } from 'node:util';

import { FILESYSTEMS, type FilesystemType, LVM_EXTENT_BYTES } from '@ohr/shared/constants';
import { volumeGroupName } from '@ohr/shared/naming';
import { derivePools } from '@ohr/shared/pool-view';
import { alignDown, formatSize } from '@ohr/shared/sizes';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';
import type { VolumeGrowInput, VolumeGrowTarget } from '@ohr/shared/volume-grow-input';
import type { VolumeGrowRequest } from '@ohr/shared/volume-grow-request';

import type { PreviewResult } from './preview-result.ts';

interface MountedVolume {
  readonly filesystem: FilesystemType;
  readonly mountPoint: string;
  readonly sizeBytes: number;
  /** What the pool's volume group has free. */
  readonly freeBytes: number;
}

function isFilesystem(value: string | null): value is FilesystemType {
  return FILESYSTEMS.some((type) => type === value);
}

/** Free space as the job's lvextend sees it: whole extents. */
function groupFree(snapshot: SystemSnapshot, poolId: string): number | null {
  const group = snapshot.volumeGroups.find(
    (candidate) => candidate.name === volumeGroupName(poolId),
  );
  if (group === undefined) {
    return null;
  }
  return alignDown(group.freeBytes, LVM_EXTENT_BYTES);
}

/** The volume with where it is mounted, or why it cannot be grown online. */
export function mountedVolume(
  snapshot: SystemSnapshot,
  poolId: string,
  name: string,
): MountedVolume | { readonly reason: string } {
  const pool = derivePools(snapshot).find((candidate) => candidate.id === poolId);
  const freeBytes = groupFree(snapshot, poolId);
  if (pool === undefined || freeBytes === null) {
    return { reason: `There is no pool ${poolId} on this machine.` };
  }
  const volume = pool.volumes.find((candidate) => candidate.name === name);
  if (volume === undefined) {
    return { reason: `Pool ${poolId} has no volume named ${name}.` };
  }
  if (volume.mountPoint === null) {
    return { reason: `Volume ${name} is not mounted. It grows online, so mount it first.` };
  }
  if (!isFilesystem(volume.filesystem)) {
    return {
      reason: `Volume ${name} holds ${volume.filesystem ?? 'no filesystem'}, which Open HR does not grow.`,
    };
  }
  return {
    filesystem: volume.filesystem,
    mountPoint: volume.mountPoint,
    sizeBytes: volume.sizeBytes,
    freeBytes,
  };
}

/** Checks the request against the snapshot and builds the input. */
export function previewVolumeGrow(
  request: VolumeGrowRequest,
  snapshot: SystemSnapshot,
): PreviewResult<VolumeGrowInput> {
  const found = mountedVolume(snapshot, request.poolId, request.name);
  if ('reason' in found) {
    return { ok: false, reasons: [found.reason] };
  }
  if (found.freeBytes <= 0) {
    return { ok: false, reasons: [`Pool ${request.poolId} has no free space.`] };
  }
  const target: Omit<VolumeGrowTarget, 'size'> = {
    name: request.name,
    filesystem: found.filesystem,
    mountPoint: found.mountPoint,
  };
  if (request.size.kind === 'all-free') {
    return { ok: true, value: { poolId: request.poolId, ...target, size: { kind: 'all-free' } } };
  }
  const added = alignDown(request.size.bytes, LVM_EXTENT_BYTES);
  if (added <= 0) {
    return { ok: false, reasons: [`Grow a volume by at least ${formatSize(LVM_EXTENT_BYTES)}.`] };
  }
  if (added > found.freeBytes) {
    return {
      ok: false,
      reasons: [
        `Pool ${request.poolId} has ${formatSize(found.freeBytes)} free, less than the ${formatSize(added)} asked for.`,
      ],
    };
  }
  return {
    ok: true,
    value: {
      poolId: request.poolId,
      ...target,
      size: { kind: 'bytes', bytes: found.sizeBytes + added },
    },
  };
}

/** The volume's size in bytes once the job has run. */
export function grownSizeBytes(input: VolumeGrowInput, snapshot: SystemSnapshot): number {
  if (input.size.kind === 'bytes') {
    return input.size.bytes;
  }
  const found = mountedVolume(snapshot, input.poolId, input.name);
  if ('reason' in found) {
    return 0;
  }
  return found.sizeBytes + found.freeBytes;
}

/**
 * Checks a submitted input against the system as it is now. A size in bytes
 * must still be reachable from the volume's current size; all free space
 * needs some free space.
 */
export function recheckVolumeGrow(input: VolumeGrowInput, snapshot: SystemSnapshot): string[] {
  const found = mountedVolume(snapshot, input.poolId, input.name);
  if ('reason' in found) {
    return [found.reason];
  }
  let request: VolumeGrowRequest = {
    poolId: input.poolId,
    name: input.name,
    size: { kind: 'all-free' },
  };
  if (input.size.kind === 'bytes') {
    const added = input.size.bytes - found.sizeBytes;
    if (added <= 0) {
      return [`Volume ${input.name} is already ${formatSize(found.sizeBytes)}. Preview it again.`];
    }
    request = { ...request, size: { kind: 'add-bytes', bytes: added } };
  }
  const fresh = previewVolumeGrow(request, snapshot);
  if (!fresh.ok) {
    return [...fresh.reasons];
  }
  if (!isDeepStrictEqual(fresh.value, input)) {
    return ['The submitted change does not match a fresh preview. Preview it again.'];
  }
  return [];
}
