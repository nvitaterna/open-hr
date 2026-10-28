/** Decides what each physical drive is currently used for. */

import { PARTITION_LABEL_PREFIX } from '@ohr/shared/naming';
import { type BlockDevice, flattenBlockDevices } from '@ohr/shared/parsers/lsblk';

/** Mount points that mean a drive holds the running operating system. */
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/boot/efi', '/usr', '/var', '/home', '[SWAP]']);

/** Kernel devices that look like disks but are not physical drives. */
const VIRTUAL_DISK = /^(?:zram|ram|nbd|loop)\d/u;

/**
 * - system: holds the running operating system. Never touched.
 * - ohr: has partitions written by Open HR.
 * - in-use: has partitions, a filesystem, or other signatures. Needs wiping before use.
 * - empty: nothing on it.
 */
export type DriveRole = 'system' | 'ohr' | 'in-use' | 'empty';

/** Physical drives at the top of an lsblk tree. */
export function physicalDrives(devices: readonly BlockDevice[]): BlockDevice[] {
  return devices.filter(
    (device) => device.type === 'disk' && device.sizeBytes > 0 && !VIRTUAL_DISK.test(device.name),
  );
}

export function driveRole(drive: BlockDevice): DriveRole {
  const descendants = flattenBlockDevices(drive.children);
  const everything = [drive, ...descendants];
  if (everything.some((device) => device.mountpoints.some((point) => SYSTEM_MOUNTS.has(point)))) {
    return 'system';
  }
  if (descendants.some((device) => device.partLabel?.startsWith(PARTITION_LABEL_PREFIX) === true)) {
    return 'ohr';
  }
  if (drive.fsType !== null || drive.children.length > 0 || drive.mountpoints.length > 0) {
    return 'in-use';
  }
  return 'empty';
}
