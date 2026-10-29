/**
 * A fingerprint of the parts of the system a job depends on (decision 0006).
 * It is computed when a job is previewed and again before it runs; a change
 * means the machine is not the one the user confirmed, and the job must not
 * run.
 */

import { createHash } from 'node:crypto';

import type { SystemSnapshot } from '../system-state.ts';

function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** The SHA-256 of what a structural job cares about, as a hex string. */
export function systemStateHash(snapshot: SystemSnapshot): string {
  const drives = [...snapshot.drives]
    .sort((a, b) => a.device.path.localeCompare(b.device.path))
    .map((drive) => ({
      path: drive.device.path,
      serial: drive.device.serial,
      wwn: drive.device.wwn,
      sizeBytes: drive.device.sizeBytes,
      role: drive.role,
      partitions: drive.device.children.length,
    }));
  const fingerprint = {
    drives,
    mdArrays: sorted(snapshot.mdArrays.map((array) => array.name)),
    volumeGroups: sorted(snapshot.volumeGroups.map((group) => group.name)),
    logicalVolumes: sorted(
      snapshot.logicalVolumes.map((volume) => `${volume.volumeGroup}/${volume.name}`),
    ),
    mounts: sorted(snapshot.mounts.map((mount) => mount.target)),
  };
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
}
