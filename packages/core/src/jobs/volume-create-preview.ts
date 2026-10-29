/**
 * Turns a volume-create request into the job input, or into the reasons it
 * is refused (decision 0007). Pure: it reads only the snapshot it is given.
 * Core runs it at preview time and again at submit time.
 */

import { isDeepStrictEqual } from 'node:util';

import { LVM_EXTENT_BYTES } from '@ohr/shared/constants';
import { volumeGroupName } from '@ohr/shared/naming';
import { alignDown, formatSize } from '@ohr/shared/sizes';
import type { SystemSnapshot } from '@ohr/shared/system-snapshot';
import type { VolumeCreateInput } from '@ohr/shared/volume-create-input';
import type { VolumeCreateRequest } from '@ohr/shared/volume-create-request';

import { assertMountPoint, defaultMountPoint } from '../executors/mount.ts';
import type { PreviewResult } from './preview-result.ts';

function resolveSize(request: VolumeCreateRequest): VolumeCreateInput['size'] | string {
  if (request.size.kind === 'all-free') {
    return request.size;
  }
  const bytes = alignDown(request.size.bytes, LVM_EXTENT_BYTES);
  if (bytes <= 0) {
    return `A volume needs at least ${formatSize(LVM_EXTENT_BYTES)}.`;
  }
  return { kind: 'bytes', bytes };
}

function resolveMountPoint(request: VolumeCreateRequest): string | null {
  const mountPoint = request.mountPoint ?? defaultMountPoint(request.name);
  try {
    assertMountPoint(mountPoint);
    return mountPoint;
  } catch {
    return null;
  }
}

/** What stops the volume from being created, or nothing. */
function problems(input: VolumeCreateInput, snapshot: SystemSnapshot): string[] {
  const groupName = volumeGroupName(input.poolId);
  const group = snapshot.volumeGroups.find((candidate) => candidate.name === groupName);
  if (group === undefined) {
    return [`There is no pool ${input.poolId} on this machine (no volume group ${groupName}).`];
  }
  const found: string[] = [];
  if (
    snapshot.logicalVolumes.some(
      (volume) => volume.volumeGroup === groupName && volume.name === input.name,
    )
  ) {
    found.push(`Pool ${input.poolId} already has a volume named ${input.name}.`);
  }
  if (input.size.kind === 'all-free' && group.freeBytes <= 0) {
    found.push(`Pool ${input.poolId} has no free space.`);
  } else if (input.size.kind === 'bytes' && input.size.bytes > group.freeBytes) {
    found.push(
      `Pool ${input.poolId} has ${formatSize(group.freeBytes)} free, less than the ${formatSize(input.size.bytes)} asked for.`,
    );
  }
  if (snapshot.mounts.some((mount) => mount.target === input.mountPoint)) {
    found.push(`${input.mountPoint} already has something mounted on it.`);
  }
  return found;
}

/** The volume's size in bytes as the job will make it: the request, or the pool's free space now. */
export function volumeSizeBytes(input: VolumeCreateInput, snapshot: SystemSnapshot): number {
  if (input.size.kind === 'bytes') {
    return input.size.bytes;
  }
  const groupName = volumeGroupName(input.poolId);
  return snapshot.volumeGroups.find((group) => group.name === groupName)?.freeBytes ?? 0;
}

/** Checks the request against the snapshot and builds the input. */
export function previewVolumeCreate(
  request: VolumeCreateRequest,
  snapshot: SystemSnapshot,
): PreviewResult<VolumeCreateInput> {
  const size = resolveSize(request);
  const mountPoint = resolveMountPoint(request);
  const reasons: string[] = [];
  if (typeof size === 'string') {
    reasons.push(size);
  }
  if (mountPoint === null) {
    reasons.push(
      `The mount point must be an absolute directory path, got "${request.mountPoint}".`,
    );
  }
  if (typeof size === 'string' || mountPoint === null) {
    return { ok: false, reasons };
  }
  const input: VolumeCreateInput = {
    poolId: request.poolId,
    name: request.name,
    filesystem: request.filesystem,
    size,
    mountPoint,
  };
  const found = problems(input, snapshot);
  if (found.length > 0) {
    return { ok: false, reasons: found };
  }
  return { ok: true, value: input };
}

/** Checks a submitted input against the system as it is now: the same checks as the preview. */
export function recheckVolumeCreate(input: VolumeCreateInput, snapshot: SystemSnapshot): string[] {
  const fresh = previewVolumeCreate(input, snapshot);
  if (!fresh.ok) {
    return [...fresh.reasons];
  }
  if (!isDeepStrictEqual(fresh.value, input)) {
    return ['The submitted volume does not match a fresh preview. Preview it again.'];
  }
  return [];
}
