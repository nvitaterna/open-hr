/**
 * The machine's storage state as one typed snapshot, and zod schemas for it.
 * Core reads the snapshot; the CLI, web, and UI receive it over RPC and
 * validate it with these schemas. Each schema is annotated with the type the
 * parsers produce, so a field added to a parser without a schema change fails
 * the typecheck.
 */

import { z } from 'zod';

import type { Mount } from './parsers/findmnt.ts';
import type { BlockDevice } from './parsers/lsblk.ts';
import type { LogicalVolume, PhysicalVolume, VolumeGroup } from './parsers/lvm.ts';
import type { MdDetail, MdMember } from './parsers/mdadm-detail.ts';
import type { MdstatArray, MdstatHealth, MdstatMember, MdstatSync } from './parsers/mdstat.ts';
import type { SmartExitFlags, SmartMessage, SmartReport } from './parsers/smartctl.ts';

const blockDeviceSchema: z.ZodType<BlockDevice> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    parentName: z.string().nullable(),
    type: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    model: z.string().nullable(),
    serial: z.string().nullable(),
    wwn: z.string().nullable(),
    transport: z.string().nullable(),
    rotational: z.boolean(),
    removable: z.boolean(),
    readOnly: z.boolean(),
    fsType: z.string().nullable(),
    uuid: z.string().nullable(),
    partUuid: z.string().nullable(),
    partLabel: z.string().nullable(),
    partType: z.string().nullable(),
    partNumber: z.number().int().nullable(),
    mountpoints: z.array(z.string()),
    children: z.array(blockDeviceSchema),
  }),
);

const smartExitFlagsSchema: z.ZodType<SmartExitFlags> = z.object({
  commandLineError: z.boolean(),
  deviceOpenFailed: z.boolean(),
  commandFailed: z.boolean(),
  diskFailing: z.boolean(),
  prefailBelowThreshold: z.boolean(),
  pastThreshold: z.boolean(),
  errorLogHasErrors: z.boolean(),
  selfTestLogHasErrors: z.boolean(),
});

const smartMessageSchema: z.ZodType<SmartMessage> = z.object({
  text: z.string(),
  severity: z.string(),
});

const smartReportSchema: z.ZodType<SmartReport> = z.object({
  device: z.string().nullable(),
  protocol: z.string().nullable(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  firmware: z.string().nullable(),
  capacityBytes: z.number().nullable(),
  passed: z.boolean().nullable(),
  temperatureCelsius: z.number().nullable(),
  powerOnHours: z.number().nullable(),
  reallocatedSectors: z.number().nullable(),
  pendingSectors: z.number().nullable(),
  offlineUncorrectable: z.number().nullable(),
  mediaErrors: z.number().nullable(),
  percentageUsed: z.number().nullable(),
  criticalWarning: z.number().nullable(),
  exitStatus: z.number().int(),
  exitFlags: smartExitFlagsSchema,
  messages: z.array(smartMessageSchema),
});

const mdstatMemberSchema: z.ZodType<MdstatMember> = z.object({
  device: z.string(),
  slot: z.number().int(),
  faulty: z.boolean(),
  spare: z.boolean(),
  writeMostly: z.boolean(),
  journal: z.boolean(),
  replacement: z.boolean(),
});

const mdstatHealthSchema: z.ZodType<MdstatHealth> = z.object({
  expectedDevices: z.number().int(),
  workingDevices: z.number().int(),
  memberMap: z.string(),
});

const mdstatSyncSchema: z.ZodType<MdstatSync> = z.object({
  action: z.enum(['resync', 'recovery', 'reshape', 'check', 'repair']),
  state: z.enum(['running', 'delayed', 'pending']),
  percent: z.number().nullable(),
  doneBlocks: z.number().nullable(),
  totalBlocks: z.number().nullable(),
  finishMinutes: z.number().nullable(),
  speedKibPerSecond: z.number().nullable(),
});

const mdstatArraySchema: z.ZodType<MdstatArray> = z.object({
  name: z.string(),
  active: z.boolean(),
  readOnly: z.boolean(),
  autoReadOnly: z.boolean(),
  level: z.string().nullable(),
  members: z.array(mdstatMemberSchema),
  sizeBytes: z.number().nullable(),
  health: mdstatHealthSchema.nullable(),
  sync: mdstatSyncSchema.nullable(),
});

const mdMemberSchema: z.ZodType<MdMember> = z.object({
  device: z.string(),
  role: z.union([z.number().int(), z.enum(['spare', 'faulty', 'journal'])]),
});

const mdDetailSchema: z.ZodType<MdDetail> = z.object({
  level: z.string(),
  raidDevices: z.number().int(),
  metadata: z.string().nullable(),
  uuid: z.string(),
  devName: z.string().nullable(),
  name: z.string().nullable(),
  members: z.array(mdMemberSchema),
});

const physicalVolumeSchema: z.ZodType<PhysicalVolume> = z.object({
  device: z.string(),
  volumeGroup: z.string().nullable(),
  uuid: z.string(),
  sizeBytes: z.number(),
  freeBytes: z.number(),
});

const volumeGroupSchema: z.ZodType<VolumeGroup> = z.object({
  name: z.string(),
  uuid: z.string(),
  sizeBytes: z.number(),
  freeBytes: z.number(),
  physicalVolumeCount: z.number().int(),
  logicalVolumeCount: z.number().int(),
});

const logicalVolumeSchema: z.ZodType<LogicalVolume> = z.object({
  name: z.string(),
  volumeGroup: z.string(),
  uuid: z.string(),
  sizeBytes: z.number(),
  path: z.string().nullable(),
  attributes: z.string(),
  layout: z.string(),
});

const mountSchema: z.ZodType<Mount> = z.object({
  target: z.string(),
  source: z.string(),
  device: z.string(),
  fsType: z.string(),
  options: z.array(z.string()),
  sizeBytes: z.number().nullable(),
  usedBytes: z.number().nullable(),
  availableBytes: z.number().nullable(),
});

/**
 * - system: holds the running operating system. Never touched.
 * - ohr: has partitions written by Open HR.
 * - in-use: has partitions, a filesystem, or other signatures. Needs wiping before use.
 * - empty: nothing on it.
 */
export const DRIVE_ROLES = ['system', 'ohr', 'in-use', 'empty'] as const;

export const driveRoleSchema = z.enum(DRIVE_ROLES);

export type DriveRole = z.infer<typeof driveRoleSchema>;

export interface DriveState {
  /** The drive and everything below it, as lsblk reports it. */
  readonly device: BlockDevice;
  readonly role: DriveRole;
  /** Null when SMART was not requested or could not be read. */
  readonly smart: SmartReport | null;
}

export interface MdArrayState {
  /** Kernel name, such as "md127". */
  readonly name: string;
  readonly path: string;
  readonly status: MdstatArray;
  /** Null when mdadm could not be run, for example without root. */
  readonly detail: MdDetail | null;
}

export interface SystemSnapshot {
  readonly drives: readonly DriveState[];
  readonly mdArrays: readonly MdArrayState[];
  readonly physicalVolumes: readonly PhysicalVolume[];
  readonly volumeGroups: readonly VolumeGroup[];
  readonly logicalVolumes: readonly LogicalVolume[];
  readonly mounts: readonly Mount[];
  /** Things that could not be read. The snapshot is still usable but incomplete. */
  readonly warnings: readonly string[];
}

export const driveStateSchema: z.ZodType<DriveState> = z.object({
  device: blockDeviceSchema,
  role: driveRoleSchema,
  smart: smartReportSchema.nullable(),
});

export const mdArrayStateSchema: z.ZodType<MdArrayState> = z.object({
  name: z.string(),
  path: z.string(),
  status: mdstatArraySchema,
  detail: mdDetailSchema.nullable(),
});

export const systemSnapshotSchema: z.ZodType<SystemSnapshot> = z.object({
  drives: z.array(driveStateSchema),
  mdArrays: z.array(mdArrayStateSchema),
  physicalVolumes: z.array(physicalVolumeSchema),
  volumeGroups: z.array(volumeGroupSchema),
  logicalVolumes: z.array(logicalVolumeSchema),
  mounts: z.array(mountSchema),
  warnings: z.array(z.string()),
});
