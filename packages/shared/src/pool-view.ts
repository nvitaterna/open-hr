/**
 * Pools, their tiers and volumes, and drives, as the UI and the CLI show
 * them (plan section 5.6). Everything is derived from one system snapshot,
 * which stays the source of truth (plan section 5.4): a pool is whatever the
 * partition names, md arrays, LVM, and labels on the machine say it is.
 * Pure, so the browser can run it too.
 */

import { z } from 'zod';

import {
  isValidPoolId,
  mdArrayName,
  type PartitionRole,
  parseMdArrayName,
  parsePartitionLabel,
  volumeGroupName,
} from './naming.ts';
import { type BlockDevice, flattenBlockDevices } from './parsers/lsblk.ts';
import { isDegraded, type MdstatSync } from './parsers/mdstat.ts';
import {
  type DriveState,
  driveRoleSchema,
  type LabelReading,
  type MdArrayState,
  type SystemSnapshot,
} from './system-snapshot.ts';

const VOLUME_GROUP_PREFIX = 'ohr-';
const RAID_TYPE_PREFIX = 'raid';
const MISSING_SLOT = '_';
const REBUILD_ACTIONS: ReadonlySet<string> = new Set(['recovery']);
const SYNC_ACTIONS: ReadonlySet<string> = new Set(['resync', 'reshape', 'recovery']);

interface FoundPartition {
  readonly drive: DriveState;
  readonly partition: BlockDevice;
  readonly role: PartitionRole;
}

/** Every Open HR partition on the snapshot's drives, in drive order. */
function ohrPartitions(snapshot: SystemSnapshot): FoundPartition[] {
  return snapshot.drives.flatMap((drive) =>
    drive.device.children.flatMap((partition) => {
      const role = parsePartitionLabel(partition.partLabel ?? '');
      if (role === null) {
        return [];
      }
      return [{ drive, partition, role }];
    }),
  );
}

/** Device-mapper escapes a dash in a VG or LV name by doubling it. */
function mapperName(volumeGroup: string, volume: string): string {
  return `${volumeGroup.replaceAll('-', '--')}-${volume.replaceAll('-', '--')}`;
}

function findArray(
  snapshot: SystemSnapshot,
  poolId: string,
  tier: number,
  partitions: readonly FoundPartition[],
): MdArrayState | null {
  // lsblk shows the array under its members even when mdadm cannot be run.
  const kernelName = partitions
    .flatMap((found) => found.partition.children)
    .find((child) => child.type.startsWith(RAID_TYPE_PREFIX))?.name;
  const name = mdArrayName(poolId, tier);
  return (
    snapshot.mdArrays.find(
      (array) => array.name === kernelName || array.detail?.devName === name,
    ) ?? null
  );
}

function memberState(array: MdArrayState | null, partition: BlockDevice): MemberState {
  const member = array?.status.members.find((candidate) => candidate.device === partition.name);
  if (array === null || member === undefined) {
    return 'missing';
  }
  if (member.faulty) {
    return 'faulty';
  }
  if (member.spare) {
    return 'spare';
  }
  if (array.status.health?.memberMap[member.slot] === MISSING_SLOT) {
    return 'rebuilding';
  }
  return 'active';
}

function tierHealth(array: MdArrayState | null): TierHealth {
  if (array === null) {
    return 'missing';
  }
  if (!array.status.active) {
    return 'inactive';
  }
  const action = array.status.sync?.action;
  if (isDegraded(array.status)) {
    if (action !== undefined && REBUILD_ACTIONS.has(action)) {
      return 'rebuilding';
    }
    return 'degraded';
  }
  if (action !== undefined && SYNC_ACTIONS.has(action)) {
    return 'syncing';
  }
  return 'healthy';
}

function syncView(sync: MdstatSync | null): TierView['sync'] {
  if (sync === null) {
    return null;
  }
  return {
    action: sync.action,
    state: sync.state,
    percent: sync.percent,
    finishMinutes: sync.finishMinutes,
    speedKibPerSecond: sync.speedKibPerSecond,
  };
}

function tierView(
  snapshot: SystemSnapshot,
  poolId: string,
  tier: number,
  found: readonly FoundPartition[],
): TierView {
  const partitions = found.filter((item) => item.role.kind === 'tier' && item.role.tier === tier);
  const array = findArray(snapshot, poolId, tier, partitions);
  return {
    tier,
    arrayPath: `/dev/md/${mdArrayName(poolId, tier)}`,
    kernelName: array?.name ?? null,
    level: array?.status.level ?? array?.detail?.level ?? null,
    sizeBytes: array?.status.sizeBytes ?? null,
    expectedMembers: array?.status.health?.expectedDevices ?? array?.detail?.raidDevices ?? null,
    health: tierHealth(array),
    sync: syncView(array?.status.sync ?? null),
    members: partitions.map((item) => ({
      drive: item.drive.device.path,
      partition: item.partition.path,
      state: memberState(array, item.partition),
    })),
  };
}

function tierNumbers(
  snapshot: SystemSnapshot,
  poolId: string,
  found: readonly FoundPartition[],
): number[] {
  const tiers = new Set<number>();
  for (const item of found) {
    if (item.role.kind === 'tier') {
      tiers.add(item.role.tier);
    }
  }
  for (const array of snapshot.mdArrays) {
    const parsed = parseMdArrayName(array.detail?.devName ?? '');
    if (parsed?.poolId === poolId) {
      tiers.add(parsed.tier);
    }
  }
  return [...tiers].sort((a, b) => a - b);
}

function labelStatus(reading: LabelReading | undefined): LabelStatus {
  return reading?.kind ?? 'not-read';
}

function volumes(snapshot: SystemSnapshot, groupName: string): VolumeView[] {
  const devices = snapshot.drives.flatMap((drive) => flattenBlockDevices([drive.device]));
  return snapshot.logicalVolumes
    .filter((volume) => volume.volumeGroup === groupName)
    .map((volume) => {
      const mapper = mapperName(groupName, volume.name);
      const mapperPath = `/dev/mapper/${mapper}`;
      const mount = snapshot.mounts.find(
        (candidate) => candidate.device === mapperPath || candidate.device === volume.path,
      );
      const device = devices.find(
        (candidate) => candidate.type === 'lvm' && candidate.name === mapper,
      );
      return {
        name: volume.name,
        path: volume.path ?? `/dev/${groupName}/${volume.name}`,
        sizeBytes: volume.sizeBytes,
        filesystem: mount?.fsType ?? device?.fsType ?? null,
        mountPoint: mount?.target ?? null,
        usedBytes: mount?.usedBytes ?? null,
        availableBytes: mount?.availableBytes ?? null,
      };
    });
}

function poolHealth(tiers: readonly TierView[]): PoolHealth {
  const healths = new Set(tiers.map((tier) => tier.health));
  if (tiers.length === 0 || healths.has('missing') || healths.has('inactive')) {
    return 'unavailable';
  }
  for (const health of ['degraded', 'rebuilding', 'syncing'] as const) {
    if (healths.has(health)) {
      return health;
    }
  }
  return 'healthy';
}

function poolDrive(
  items: readonly FoundPartition[],
  readings: ReadonlyMap<string, LabelReading>,
  warnings: string[],
): PoolDriveView {
  const [first] = items;
  if (first === undefined) {
    throw new Error('A pool drive needs at least one partition');
  }
  const { device } = first.drive;
  const labelPartition = items.find((item) => item.role.kind === 'label')?.partition;
  if (labelPartition === undefined) {
    warnings.push(`${device.path} has no label partition.`);
    return driveSummary(device, null, 'missing');
  }
  const reading = readings.get(labelPartition.path);
  if (reading?.kind === 'invalid' || reading?.kind === 'unreadable') {
    warnings.push(`The label on ${labelPartition.path} could not be read: ${reading.reason}.`);
  } else if (reading?.kind === 'empty') {
    warnings.push(`The label partition ${labelPartition.path} is empty.`);
  } else if (reading?.kind === 'unsupported') {
    warnings.push(`The label on ${labelPartition.path} is from a newer Open HR.`);
  }
  if (reading?.kind === 'ok') {
    return driveSummary(device, reading.descriptor.driveUuid, 'ok');
  }
  return driveSummary(device, null, labelStatus(reading));
}

function driveSummary(
  device: BlockDevice,
  driveUuid: string | null,
  label: LabelStatus,
): PoolDriveView {
  return {
    path: device.path,
    model: device.model,
    serial: device.serial,
    sizeBytes: device.sizeBytes,
    driveUuid,
    label,
  };
}

function poolView(
  snapshot: SystemSnapshot,
  poolId: string,
  found: readonly FoundPartition[],
): PoolView {
  const warnings: string[] = [];
  const readings = new Map(snapshot.labels.map((label) => [label.partition, label.reading]));
  const byDrive = new Map<string, FoundPartition[]>();
  for (const item of found) {
    byDrive.set(item.drive.device.path, [...(byDrive.get(item.drive.device.path) ?? []), item]);
  }
  const drives = [...byDrive.values()].map((items) => poolDrive(items, readings, warnings));
  const descriptors = [...readings.entries()]
    .filter(([partition]) => found.some((item) => item.partition.path === partition))
    .flatMap(([, reading]) => {
      if (reading.kind === 'ok') {
        return [reading.descriptor];
      }
      return [];
    });
  const uuids = new Set(descriptors.map((descriptor) => descriptor.poolUuid));
  if (uuids.size > 1) {
    warnings.push(`The drives' labels name ${uuids.size} different pools with the id ${poolId}.`);
  }
  const tiers = tierNumbers(snapshot, poolId, found).map((tier) =>
    tierView(snapshot, poolId, tier, found),
  );
  for (const tier of tiers) {
    if (tier.health === 'missing') {
      warnings.push(`The array for tier ${tier.tier} is not running.`);
    }
  }
  const groupName = volumeGroupName(poolId);
  const group = snapshot.volumeGroups.find((candidate) => candidate.name === groupName);
  if (group === undefined) {
    warnings.push(`Volume group ${groupName} is not active.`);
  }
  return {
    id: poolId,
    uuid: descriptors[0]?.poolUuid ?? null,
    redundancy: descriptors[0]?.redundancy ?? null,
    health: poolHealth(tiers),
    sizeBytes: group?.sizeBytes ?? null,
    freeBytes: group?.freeBytes ?? null,
    drives,
    tiers,
    volumes: volumes(snapshot, groupName),
    warnings,
  };
}

export const TIER_HEALTHS = [
  'healthy',
  'syncing',
  'rebuilding',
  'degraded',
  'inactive',
  'missing',
] as const;
export const POOL_HEALTHS = [
  'healthy',
  'syncing',
  'rebuilding',
  'degraded',
  'unavailable',
] as const;
export const MEMBER_STATES = ['active', 'rebuilding', 'spare', 'faulty', 'missing'] as const;
export const LABEL_STATUSES = [
  'ok',
  'empty',
  'unsupported',
  'invalid',
  'unreadable',
  'missing',
  'not-read',
] as const;

export const memberViewSchema = z.strictObject({
  /** The drive's device path. */
  drive: z.string(),
  /** The tier partition's device path. */
  partition: z.string(),
  state: z.enum(MEMBER_STATES),
});

export const tierViewSchema = z.strictObject({
  tier: z.number().int().positive(),
  /** /dev/md/ohr_<pool>_t<k>. */
  arrayPath: z.string(),
  /** Kernel name such as md127, or null when the array is not running. */
  kernelName: z.string().nullable(),
  level: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  expectedMembers: z.number().int().nullable(),
  health: z.enum(TIER_HEALTHS),
  sync: z
    .strictObject({
      action: z.string(),
      state: z.string(),
      percent: z.number().nullable(),
      finishMinutes: z.number().nullable(),
      speedKibPerSecond: z.number().nullable(),
    })
    .nullable(),
  members: z.array(memberViewSchema),
});

export const poolDriveViewSchema = z.strictObject({
  path: z.string(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  sizeBytes: z.number(),
  /** From the drive's label, or null when it could not be read. */
  driveUuid: z.string().nullable(),
  label: z.enum(LABEL_STATUSES),
});

export const volumeViewSchema = z.strictObject({
  name: z.string(),
  /** /dev/ohr-<pool>/<name>. */
  path: z.string(),
  sizeBytes: z.number(),
  filesystem: z.string().nullable(),
  mountPoint: z.string().nullable(),
  usedBytes: z.number().nullable(),
  availableBytes: z.number().nullable(),
});

export const poolViewSchema = z.strictObject({
  id: z.string(),
  /** From the labels. Null when no label could be read. */
  uuid: z.string().nullable(),
  redundancy: z.enum(['shr1', 'shr2']).nullable(),
  health: z.enum(POOL_HEALTHS),
  /** The volume group's size and free space, or null when it is not active. */
  sizeBytes: z.number().nullable(),
  freeBytes: z.number().nullable(),
  drives: z.array(poolDriveViewSchema),
  tiers: z.array(tierViewSchema),
  volumes: z.array(volumeViewSchema),
  /** Things that look wrong, one sentence each. */
  warnings: z.array(z.string()),
});

export const driveViewSchema = z.strictObject({
  path: z.string(),
  name: z.string(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  wwn: z.string().nullable(),
  sizeBytes: z.number(),
  transport: z.string().nullable(),
  rotational: z.boolean(),
  role: driveRoleSchema,
  /** The pool whose partitions are on the drive, or null. */
  poolId: z.string().nullable(),
  /** From SMART, or null when it was not read. */
  temperatureCelsius: z.number().nullable(),
  smartPassed: z.boolean().nullable(),
});

export type TierHealth = (typeof TIER_HEALTHS)[number];
export type PoolHealth = (typeof POOL_HEALTHS)[number];
export type MemberState = (typeof MEMBER_STATES)[number];
export type LabelStatus = (typeof LABEL_STATUSES)[number];
export type TierView = z.infer<typeof tierViewSchema>;
export type PoolDriveView = z.infer<typeof poolDriveViewSchema>;
export type VolumeView = z.infer<typeof volumeViewSchema>;
export type PoolView = z.infer<typeof poolViewSchema>;
export type DriveView = z.infer<typeof driveViewSchema>;

/** Every pool on the machine, by id. */
export function derivePools(snapshot: SystemSnapshot): PoolView[] {
  const found = ohrPartitions(snapshot);
  const ids = new Set(found.map((item) => item.role.poolId));
  for (const group of snapshot.volumeGroups) {
    const id = group.name.slice(VOLUME_GROUP_PREFIX.length);
    if (group.name.startsWith(VOLUME_GROUP_PREFIX) && isValidPoolId(id)) {
      ids.add(id);
    }
  }
  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .map((id) =>
      poolView(
        snapshot,
        id,
        found.filter((item) => item.role.poolId === id),
      ),
    );
}

/** Every drive, with the pool it belongs to. */
export function deriveDrives(snapshot: SystemSnapshot): DriveView[] {
  return snapshot.drives.map((drive) => {
    const { device } = drive;
    const poolId =
      device.children
        .map((partition) => parsePartitionLabel(partition.partLabel ?? '')?.poolId)
        .find((id) => id !== undefined) ?? null;
    return {
      path: device.path,
      name: device.name,
      model: device.model,
      serial: device.serial,
      wwn: device.wwn,
      sizeBytes: device.sizeBytes,
      transport: device.transport,
      rotational: device.rotational,
      role: drive.role,
      poolId,
      temperatureCelsius: drive.smart?.temperatureCelsius ?? null,
      smartPassed: drive.smart?.passed ?? null,
    };
  });
}
