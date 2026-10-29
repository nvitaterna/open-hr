/**
 * Rules for the names users give volumes. A volume name is also the LVM
 * logical volume name and the default mount directory under /mnt/ohr, so it
 * is kept to characters that are safe in both.
 */

/** 1 to 32 lowercase letters, digits, dashes, or underscores, not starting with a dash or underscore. */
const VOLUME_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
/** Names LVM reserves for its own use (lvm(8), "Valid Names"). */
const LVM_RESERVED_NAMES = new Set(['snapshot', 'pvmove']);
/** Substrings LVM reserves for the hidden volumes it creates itself. */
const LVM_RESERVED_PARTS = [
  '_cdata',
  '_cmeta',
  '_corig',
  '_mimage',
  '_mlog',
  '_pmspare',
  '_rimage',
  '_rmeta',
  '_tdata',
  '_tmeta',
  '_vdata',
  '_vorigin',
  '_wcorig',
];

export class VolumeNameError extends Error {
  override readonly name = 'VolumeNameError';
}

export function isValidVolumeName(name: string): boolean {
  return (
    VOLUME_NAME_PATTERN.test(name) &&
    !LVM_RESERVED_NAMES.has(name) &&
    !LVM_RESERVED_PARTS.some((part) => name.includes(part))
  );
}

/** Throws VolumeNameError unless `name` is a valid volume name. */
export function assertVolumeName(name: string): void {
  if (!isValidVolumeName(name)) {
    throw new VolumeNameError(
      `Invalid volume name "${name}". Use 1 to 32 lowercase letters, digits, dashes, or underscores, starting with a letter or digit.`,
    );
  }
}
