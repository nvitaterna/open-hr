/**
 * Names Open HR gives to the things it creates. Kept in one place so every
 * package agrees, and so a user can recognise Open HR devices by name.
 */

const POOL_ID_PATTERN = /^[a-z0-9]{1,8}$/u;

/**
 * Every GPT partition name Open HR writes. Dashes, not colons, because sgdisk
 * cuts a name at the first colon (decision 0004).
 */
const PARTITION_LABEL_PATTERN = /^ohr-[a-z0-9]{1,8}-(?:label|t[1-9]\d*)$/u;

const PARTITION_LABEL_PREFIX = 'ohr-';

export class PoolIdError extends Error {
  override readonly name = 'PoolIdError';
}

/** True for a GPT partition name that Open HR writes. */
export function isOhrPartitionLabel(label: string): boolean {
  return PARTITION_LABEL_PATTERN.test(label);
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
