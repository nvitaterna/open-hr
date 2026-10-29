/**
 * Names Open HR gives to the things it creates. Kept in one place so every
 * package agrees, and so a user can recognise Open HR devices by name.
 */

const POOL_ID_PATTERN = /^[a-z0-9]{1,8}$/u;

/**
 * Every GPT partition name Open HR writes. Dashes, not colons, because sgdisk
 * cuts a name at the first colon (decision 0004).
 */
const PARTITION_LABEL_PATTERN = /^ohr-(?<poolId>[a-z0-9]{1,8})-(?:label|t(?<tier>[1-9]\d*))$/u;

const PARTITION_LABEL_PREFIX = 'ohr-';

const MD_ARRAY_NAME_PATTERN = /^ohr_(?<poolId>[a-z0-9]{1,8})_t(?<tier>[1-9]\d*)$/u;

/** What an Open HR partition name says: the pool, and the tier or the label partition. */
export type PartitionRole =
  | { readonly poolId: string; readonly kind: 'label' }
  | { readonly poolId: string; readonly kind: 'tier'; readonly tier: number };

export class PoolIdError extends Error {
  override readonly name = 'PoolIdError';
}

/** True for a GPT partition name that Open HR writes. */
export function isOhrPartitionLabel(label: string): boolean {
  return PARTITION_LABEL_PATTERN.test(label);
}

/** Splits an Open HR partition name into its parts, or null for any other name. */
export function parsePartitionLabel(label: string): PartitionRole | null {
  const groups = PARTITION_LABEL_PATTERN.exec(label)?.groups;
  if (groups?.poolId === undefined) {
    return null;
  }
  if (groups.tier === undefined) {
    return { poolId: groups.poolId, kind: 'label' };
  }
  return { poolId: groups.poolId, kind: 'tier', tier: Number(groups.tier) };
}

/** The pool and tier an md array name such as ohr_p1_t2 stands for, or null for any other name. */
export function parseMdArrayName(name: string): { poolId: string; tier: number } | null {
  const groups = MD_ARRAY_NAME_PATTERN.exec(name)?.groups;
  if (groups?.poolId === undefined || groups.tier === undefined) {
    return null;
  }
  return { poolId: groups.poolId, tier: Number(groups.tier) };
}

export function isValidPoolId(poolId: string): boolean {
  return POOL_ID_PATTERN.test(poolId);
}

/** Throws PoolIdError unless `poolId` is 1 to 8 lowercase letters or digits. */
export function assertPoolId(poolId: string): void {
  if (!isValidPoolId(poolId)) {
    throw new PoolIdError(`Invalid pool id "${poolId}". Use 1 to 8 lowercase letters or digits.`);
  }
}

/** md array name, which appears as /dev/md/<name>. */
export function mdArrayName(poolId: string, tier: number): string {
  assertPoolId(poolId);
  return `ohr_${poolId}_t${tier}`;
}

/** LVM volume group name. */
export function volumeGroupName(poolId: string): string {
  assertPoolId(poolId);
  return `ohr-${poolId}`;
}

/** GPT partition name for a tier partition. */
export function tierPartitionLabel(poolId: string, tier: number): string {
  assertPoolId(poolId);
  return `${PARTITION_LABEL_PREFIX}${poolId}-t${tier}`;
}

/** GPT partition name for the label partition that holds the drive descriptor. */
export function labelPartitionLabel(poolId: string): string {
  assertPoolId(poolId);
  return `${PARTITION_LABEL_PREFIX}${poolId}-label`;
}
