/**
 * Puts a pool's arrays under LVM (plan section 4.2): one physical volume per
 * tier array, one volume group per pool, and one logical volume per user
 * volume. Destructive: each step writes LVM metadata over the device it is
 * given. The caller checks the devices are free first; this only carries out
 * the plan.
 */

import { LVM_EXTENT_BYTES } from '@ohr/shared/constants';
import { volumeGroupName } from '@ohr/shared/naming';
import {
  type LogicalVolume,
  LV_FIELDS,
  lvmReportArgs,
  type PhysicalVolume,
  PV_FIELDS,
  parseLvs,
  parsePvs,
  parseVgs,
  VG_FIELDS,
  type VolumeGroup,
} from '@ohr/shared/parsers/lvm';
import { assertVolumeName } from '@ohr/shared/volume-name';

import { type CommandRunner, runChecked } from '../command-runner.ts';

const BYTES_PER_MIB = 1_048_576;
/** Wiping and zeroing a new volume's first blocks can be slow on sleeping drives. */
const LVM_TIMEOUT_MS = 120_000;

/** The one row a report about a single object must contain. */
function single<T>(rows: readonly T[], what: string): T {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) {
    throw new Error(`Expected one ${what} in the LVM report, got ${rows.length}`);
  }
  return row;
}

function sizeArgs(size: VolumeSize): string[] {
  if (size.kind === 'all-free') {
    return ['--extents', '100%FREE'];
  }
  const { bytes } = size;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % LVM_EXTENT_BYTES !== 0) {
    throw new RangeError(
      `Volume size must be a positive whole number of ${LVM_EXTENT_BYTES}-byte extents, got ${bytes}`,
    );
  }
  return ['--size', `${bytes}b`];
}

export type VolumeSize =
  /** Everything the volume group has left. */
  | { readonly kind: 'all-free' }
  /** An exact size, a whole number of extents so the volume is exactly this big. */
  | { readonly kind: 'bytes'; readonly bytes: number };

export interface CreateVolumeGroupRequest {
  readonly poolId: string;
  /** Device paths of the physical volumes, usually the pool's md arrays. */
  readonly physicalVolumes: readonly string[];
}

export interface CreateLogicalVolumeRequest {
  readonly poolId: string;
  readonly name: string;
  readonly size: VolumeSize;
}

/** Device path LVM gives a volume, such as /dev/ohr-p1/data. */
export function logicalVolumePath(poolId: string, name: string): string {
  assertVolumeName(name);
  return `/dev/${volumeGroupName(poolId)}/${name}`;
}

/** vgcreate arguments. The extent size is spelled out because the planner counts on it. */
export function vgcreateArgs(request: CreateVolumeGroupRequest): string[] {
  if (request.physicalVolumes.length === 0) {
    throw new RangeError('A volume group needs at least one physical volume');
  }
  return [
    '--physicalextentsize',
    `${LVM_EXTENT_BYTES / BYTES_PER_MIB}M`,
    volumeGroupName(request.poolId),
    ...request.physicalVolumes,
  ];
}

/**
 * lvcreate arguments. `--yes` with `--wipesignatures y` clears any old
 * signature in the volume's new space without asking on stdin, which the
 * daemon has none of. That space is inside arrays this pool just created, so
 * anything there is a leftover from the drives' earlier life.
 */
export function lvcreateArgs(request: CreateLogicalVolumeRequest): string[] {
  assertVolumeName(request.name);
  return [
    '--yes',
    '--wipesignatures',
    'y',
    '--zero',
    'y',
    ...sizeArgs(request.size),
    '--name',
    request.name,
    volumeGroupName(request.poolId),
  ];
}

/**
 * Wipes old signatures from the device, then makes it a physical volume.
 * pvcreate would otherwise ask on stdin before wiping, and abort.
 */
export async function createPhysicalVolume(
  run: CommandRunner,
  device: string,
): Promise<PhysicalVolume> {
  await runChecked(run, 'wipefs', ['--all', '--quiet', device]);
  await runChecked(run, 'pvcreate', [device], { timeoutMs: LVM_TIMEOUT_MS });
  const report = await runChecked(run, 'pvs', [...lvmReportArgs(PV_FIELDS), device]);
  return single(parsePvs(report), 'physical volume');
}

export async function createVolumeGroup(
  run: CommandRunner,
  request: CreateVolumeGroupRequest,
): Promise<VolumeGroup> {
  await runChecked(run, 'vgcreate', vgcreateArgs(request), { timeoutMs: LVM_TIMEOUT_MS });
  const name = volumeGroupName(request.poolId);
  const report = await runChecked(run, 'vgs', [...lvmReportArgs(VG_FIELDS), name]);
  return single(parseVgs(report), 'volume group');
}

/** Creates the volume, waits for udev to create its device link, and reports what LVM sees. */
export async function createLogicalVolume(
  run: CommandRunner,
  request: CreateLogicalVolumeRequest,
): Promise<LogicalVolume> {
  await runChecked(run, 'lvcreate', lvcreateArgs(request), { timeoutMs: LVM_TIMEOUT_MS });
  await runChecked(run, 'udevadm', ['settle']);
  const target = `${volumeGroupName(request.poolId)}/${request.name}`;
  const report = await runChecked(run, 'lvs', [...lvmReportArgs(LV_FIELDS), target]);
  return single(parseLvs(report), 'logical volume');
}
